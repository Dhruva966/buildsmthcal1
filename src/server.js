'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { createRetellCall, getCallContext, deleteCallContext } = require('./retell');
const OpenAIRealtimeAgent = require('./agent');
const { parseAndIngest } = require('./csv-parser');
const { backfillWaitlist } = require('./waitlist');
const { scoreAppointment } = require('./risk-scoring');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);
require('express-ws')(app, server);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: [
    'http://localhost:3001',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

// JSON + urlencoded for all routes
app.use((req, res, next) => {
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

// Multipart for CSV upload (manual handling via buffer)
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(process.cwd(), 'public')));

// ---------------------------------------------------------------------------
// Sentiment classification (deterministic, no LLM)
// ---------------------------------------------------------------------------

function classifySentiment(transcript) {
  if (!transcript) return 'neutral';
  const t = transcript.toLowerCase();
  if (/won't|refuse|annoyed|stop calling|leave me alone|not interested/.test(t)) return 'hostile';
  if (/nervous|scared|worried|anxious|overwhelmed|stressed/.test(t)) return 'anxious';
  if (/yes|sure|sounds good|great|thank|perfect|absolutely|looking forward/.test(t)) return 'positive';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Outcome classification from call transcript (keyword-based)
// ---------------------------------------------------------------------------

function classifyOutcomeFromTranscript(transcript) {
  if (!transcript || transcript.trim().length < 30) return 'no_answer';
  const t = transcript.toLowerCase();
  if (/reschedule|different time|can't make it|move.*appointment|another time|new time|pick another/.test(t)) return 'rescheduled';
  if (/won't come|can't come|not coming|don't want|decline|cancel|not able to|unable to make/.test(t)) return 'declined';
  if (/yes|confirm|i'll be there|will be there|sounds good|absolutely|see you|looking forward|i'll make it|i can make it|planning to/.test(t)) return 'confirmed';
  return transcript.length > 100 ? 'confirmed' : 'no_answer';
}

function classifyNoShowReason(transcript) {
  if (!transcript) return null;
  const t = transcript.toLowerCase();
  if (/transport|ride|bus|car|drive|uber|lyft|no car|no ride|getting there/.test(t)) return 'transportation';
  if (/cost|afford|insurance|pay|money|copay|deductible|expensive/.test(t)) return 'cost';
  if (/work|job|shift|meeting|busy|schedule|conflict|obligation|can't get off/.test(t)) return 'scheduling';
  if (/nerv|anxious|anxiety|scared|afraid|not ready|overwhelm|uncertain|worried about coming/.test(t)) return 'anxiety';
  if (/sick|unwell|not feeling|flu|fever|feeling bad|ill/.test(t)) return 'illness';
  if (/forgot|didn't know|not aware|didn't remember/.test(t)) return 'forgot';
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health
app.get('/api/health', async (_req, res) => {
  const activeCalls = await db.countActiveCalls().catch(() => 0);
  res.json({ status: 'ok', activeCalls, timestamp: new Date().toISOString() });
});

// CSV Upload + Risk Scoring
app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send as multipart field named "file".' });
  try {
    const result = await parseAndIngest(req.file.buffer);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, 'upload-csv failed');
    res.status(500).json({ error: err.message });
  }
});

// List upcoming appointments
app.get('/api/appointments', async (req, res) => {
  const hours = parseInt(req.query.hours || '48', 10);
  try {
    const appts = await db.listUpcomingAppointments(hours);
    res.json(appts);
  } catch (err) {
    logger.error({ err: err.message }, 'list appointments failed');
    res.status(500).json({ error: err.message });
  }
});

// All appointments (no time filter)
app.get('/api/appointments/all', async (_req, res) => {
  try {
    const appts = await db.listAllAppointments();
    res.json(appts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single appointment
app.get('/api/appointments/:id', async (req, res) => {
  try {
    const appt = await db.getAppointment(req.params.id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger outbound AI call (Twilio + OpenAI Realtime)
app.post('/api/calls/trigger', async (req, res) => {
  const { appointment_id } = req.body;
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });

  try {
    const appt = await db.getAppointment(appointment_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const patient = appt.patients;
    if (!patient?.phone) return res.status(400).json({ error: 'Patient has no phone number' });

    const slots = await db.getNextAvailableSlots(appt.provider_name, 3);

    const dynamicVars = {
      patient_name: patient.name,
      patient_age: patient.age ? String(patient.age) : '',
      patient_condition: appt.patient_condition || appt.appointment_type,
      appointment_type: appt.appointment_type,
      provider_name: appt.provider_name || 'your provider',
      scheduled_at: new Date(appt.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }),
      clinic_name: process.env.CLINIC_NAME || 'the clinic',
      no_show_count: String(patient.no_show_count || 0),
      available_slots: slots.length > 0
        ? slots.map((s, i) => `${i + 1}. ${new Date(s.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`).join('\n')
        : 'Please call us for available times.',
    };

    const { retell_call_id, call_status } = await createRetellCall({
      toNumber: patient.phone,
      dynamicVariables: dynamicVars,
      metadata: { appointment_id, patient_id: appt.patient_id },
    });

    const callRecord = await db.createCall({
      appointment_id,
      patient_id: appt.patient_id,
      retell_call_id,
    });

    await db.updateAppointmentOutreach(appointment_id, 'called');
    await db.updatePatientLastContacted(appt.patient_id);

    logger.info({ appointment_id, call_sid: retell_call_id }, 'call triggered');
    res.json({ call_id: callRecord.id, call_sid: retell_call_id, call_status });
  } catch (err) {
    logger.error({ appointment_id, err: err.message }, 'call trigger failed');
    res.status(500).json({ error: err.message });
  }
});

// List recent calls
app.get('/api/calls', async (_req, res) => {
  try {
    const calls = await db.listRecentCalls(50);
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Waitlist: register
app.post('/api/waitlist/register', async (req, res) => {
  const { patient_id, desired_slot, desired_provider, priority_score } = req.body;
  if (!patient_id || !desired_slot) return res.status(400).json({ error: 'patient_id and desired_slot required' });
  try {
    const entry = await db.addToWaitlist({ patient_id, desired_slot, desired_provider, priority_score });
    res.json(entry);
  } catch (err) {
    logger.error({ err: err.message }, 'waitlist register failed');
    res.status(500).json({ error: err.message });
  }
});

// Waitlist: manual backfill trigger
app.post('/api/waitlist/backfill', async (req, res) => {
  const { slot, provider } = req.body;
  if (!slot) return res.status(400).json({ error: 'slot required' });
  try {
    const result = await backfillWaitlist(slot, provider);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, 'waitlist backfill failed');
    res.status(500).json({ error: err.message });
  }
});

// Waitlist: list all
app.get('/api/waitlist', async (_req, res) => {
  try {
    const entries = await db.listWaitlist();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Batch call endpoints
// ---------------------------------------------------------------------------

// POST /api/calls/batch — start a consecutive batch
// Body: { appointment_ids?: string[], contacts?: { phone, name, appointment_type?, scheduled_at?, provider_name? }[] }
app.post('/api/calls/batch', async (req, res) => {
  const { appointment_ids, contacts } = req.body;
  if (batchActive || batchQueue.some(i => i.status === 'pending' || i.status === 'calling')) {
    return res.status(409).json({ error: 'A batch is already running. Cancel it first.' });
  }
  batchQueue.length = 0;

  if (appointment_ids?.length) {
    for (const aid of appointment_ids) {
      const appt = await db.getAppointment(aid).catch(() => null);
      if (!appt || !appt.patients?.phone) continue;
      const slots = await db.getNextAvailableSlots(appt.provider_name, 3).catch(() => []);
      batchQueue.push({
        id: aid,
        appointment_id: aid,
        phone: appt.patients.phone,
        name: appt.patients.name,
        status: 'pending',
        dynamicVars: {
          patient_name: appt.patients.name,
          patient_age: appt.patients.age ? String(appt.patients.age) : '',
          patient_condition: appt.patient_condition || appt.appointment_type,
          appointment_type: appt.appointment_type,
          provider_name: appt.provider_name || 'your provider',
          scheduled_at: new Date(appt.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }),
          clinic_name: process.env.CLINIC_NAME || 'the clinic',
          no_show_count: String(appt.patients.no_show_count || 0),
          available_slots: slots.length > 0
            ? slots.map((s, i) => `${i + 1}. ${new Date(s.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`).join('\n')
            : 'Please call us for available times.',
        },
      });
    }
  } else if (contacts?.length) {
    for (const c of contacts) {
      if (!c.phone) continue;
      const id = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      batchQueue.push({
        id,
        appointment_id: null,
        phone: c.phone,
        name: c.name || 'Patient',
        status: 'pending',
        dynamicVars: {
          patient_name: c.name || 'Patient',
          patient_age: c.age ? String(c.age) : '',
          patient_condition: c.condition || c.appointment_type || 'your appointment',
          appointment_type: c.appointment_type || 'appointment',
          provider_name: c.provider_name || 'your provider',
          scheduled_at: c.scheduled_at || 'your upcoming appointment',
          clinic_name: process.env.CLINIC_NAME || 'the clinic',
          no_show_count: '0',
          available_slots: 'Please call us for available times.',
        },
      });
    }
  }

  if (batchQueue.length === 0) {
    return res.status(400).json({ error: 'No valid contacts to call. Ensure phone numbers are present.' });
  }

  logger.info({ count: batchQueue.length }, 'batch: queue loaded, starting');
  res.json({ queued: batchQueue.length, queue: batchQueue });
  processNextBatch();
});

// GET /api/calls/batch-status
app.get('/api/calls/batch-status', (_req, res) => {
  res.json({
    total: batchQueue.length,
    pending: batchQueue.filter(i => i.status === 'pending').length,
    calling: batchQueue.filter(i => i.status === 'calling').length,
    done: batchQueue.filter(i => i.status === 'done').length,
    failed: batchQueue.filter(i => i.status === 'failed').length,
    active: batchActive,
    queue: batchQueue,
  });
});

// DELETE /api/calls/batch — cancel remaining
app.delete('/api/calls/batch', (_req, res) => {
  batchQueue.forEach(i => { if (i.status === 'pending') i.status = 'cancelled'; });
  batchActive = false;
  logger.info('batch: cancelled by user');
  res.json({ cancelled: true });
});

// ---------------------------------------------------------------------------
// TwiML — Twilio fetches this when patient answers
// Returns <Connect><Stream> pointing back to our /media-stream WebSocket
// ---------------------------------------------------------------------------

app.get('/outbound-twiml', (req, res) => {
  const taskId = req.query.taskId || '';
  const host = req.headers.host;
  const wsUrl = `wss://${host}/media-stream?taskId=${encodeURIComponent(taskId)}`;
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`);
});

// Twilio call status callback — acknowledge only
app.post('/call-status', (req, res) => res.sendStatus(200));

// ---------------------------------------------------------------------------
// /media-stream — Twilio Media Streams WebSocket
// Bridges Twilio audio (g711_ulaw 8kHz) ↔ OpenAI Realtime (g711_ulaw 8kHz)
// No transcoding needed — OpenAI Realtime accepts g711_ulaw natively
// ---------------------------------------------------------------------------

const mediaSessions = new Map(); // streamSid → session object

// ---------------------------------------------------------------------------
// Batch call queue — consecutive calls (one Twilio number = one at a time)
// ---------------------------------------------------------------------------

const batchQueue = []; // { id, appointment_id, phone, name, dynamicVars, status, callSid, outcome }
let batchActive = false;

async function processNextBatch() {
  const next = batchQueue.find(i => i.status === 'pending');
  if (!next || batchActive) return;
  batchActive = true;
  next.status = 'calling';
  try {
    const { retell_call_id } = await createRetellCall({
      toNumber: next.phone,
      dynamicVariables: next.dynamicVars || {},
      metadata: { appointment_id: next.appointment_id || next.id },
    });
    next.callSid = retell_call_id;
    logger.info({ batchId: next.id, callSid: retell_call_id }, 'batch: call started');
  } catch (err) {
    logger.error({ batchId: next.id, err: err.message }, 'batch: call failed');
    next.status = 'failed';
    batchActive = false;
    processNextBatch();
  }
}

app.ws('/media-stream', (ws, req) => {
  const taskId = req.query.taskId || '';
  logger.info({ taskId }, 'media-stream: connection opened');

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case 'start': {
        const { streamSid, callSid } = msg.start;

        const ctx = getCallContext(taskId);
        const appt = await db.getAppointment(taskId).catch(() => null);
        const patient = appt?.patients || null;

        const callRecord = await db.createCall({
          appointment_id: taskId || null,
          patient_id: appt?.patient_id || null,
          retell_call_id: callSid,
        }).catch(err => { logger.error({ err: err.message }, 'createCall failed'); return null; });

        const agent = new OpenAIRealtimeAgent({
          taskId,
          dynamicVariables: ctx?.dynamicVariables || {},
          onAudioOut: (base64Audio) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: base64Audio },
              }));
            }
          },
          onTranscript: ({ role, text }) => {
            logger.debug({ taskId, role, text: text.slice(0, 80) }, 'transcript fragment');
          },
        });
        agent.connect();

        mediaSessions.set(streamSid, {
          agent,
          callRecordId: callRecord?.id || null,
          taskId,
          startTime: Date.now(),
          appt,
          patient,
        });

        logger.info({ streamSid, taskId, callSid }, 'media-stream: session started');
        break;
      }

      case 'media': {
        const session = mediaSessions.get(msg.streamSid);
        session?.agent?.sendAudio(msg.media.payload);
        break;
      }

      case 'stop': {
        const { streamSid } = msg;
        const session = mediaSessions.get(streamSid);
        if (!session) break;

        const { agent, callRecordId, taskId: sid, startTime, appt, patient } = session;
        const transcript = agent.getTranscript();
        const durationSeconds = Math.round((Date.now() - startTime) / 1000);
        const outcome = classifyOutcomeFromTranscript(transcript);
        const sentiment = classifySentiment(transcript);
        const noShowReason = (outcome === 'declined' || outcome === 'rescheduled') ? classifyNoShowReason(transcript) : null;

        if (callRecordId) {
          await db.updateCall(callRecordId, {
            outcome, transcript, sentiment, duration_seconds: durationSeconds,
          }).catch(err => logger.error({ err: err.message }, 'updateCall failed'));
        }

        if (appt) {
          if (outcome === 'confirmed') {
            await db.updateAppointmentOutreach(appt.id, 'confirmed').catch(() => {});
            await db.updateAppointmentStatus(appt.id, 'confirmed').catch(() => {});
          } else if (outcome === 'rescheduled') {
            await db.updateAppointmentOutreach(appt.id, 'rescheduled').catch(() => {});
          } else {
            await db.updateAppointmentOutreach(appt.id, 'failed').catch(() => {});
            await backfillWaitlist(appt.scheduled_at, appt.provider_name).catch(() => {});
          }
        }

        const n8nUrl = process.env.N8N_WEBHOOK_URL;
        if (n8nUrl) {
          fetch(n8nUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'call_analyzed',
              timestamp: new Date().toISOString(),
              call_id: callRecordId,
              outcome,
              sentiment,
              no_show_reason: noShowReason,
              duration_seconds: durationSeconds,
              transcript,
              patient_name:     patient?.name || null,
              patient_phone:    patient?.phone || null,
              appointment_time: appt?.scheduled_at || null,
              appointment_type: appt?.appointment_type || null,
              provider_name:    appt?.provider_name || null,
              practice_email:   process.env.PRACTICE_EMAIL || null,
            }),
          }).catch(err => logger.warn({ err: err.message }, 'N8N webhook failed'));
        }

        // Advance batch queue if this call was part of one
        const batchItem = batchQueue.find(i => i.callSid === callSid || i.appointment_id === sid || i.id === sid);
        if (batchItem) {
          batchItem.status = 'done';
          batchItem.outcome = outcome;
        }
        batchActive = false;
        processNextBatch();

        agent.disconnect();
        mediaSessions.delete(streamSid);
        deleteCallContext(sid);
        logger.info({ streamSid, outcome, durationSeconds }, 'media-stream: session ended');
        break;
      }
    }
  });

  ws.on('close', () => {
    logger.info({ taskId }, 'media-stream: ws closed');
  });
});

// ---------------------------------------------------------------------------
// Static fallback
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

module.exports = { app, server };
