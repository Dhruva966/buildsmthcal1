'use strict';

/**
 * CSV ingestion for appointment data.
 * Uses Node built-in readline — no extra dependency.
 *
 * Expected columns (case-insensitive, flexible naming):
 *   name / patient_name
 *   phone / phone_number
 *   scheduled_at / appointment_date / date
 *   appointment_type / type
 *   provider_name / provider
 *   no_show_count / no_shows (optional, default 0)
 *   preferred_language (optional, default 'en')
 */

const readline = require('readline');
const { Readable } = require('stream');
const db = require('./db');
const { scoreAppointment } = require('./risk-scoring');
const logger = require('./logger');

const COLUMN_MAP = {
  name: ['name', 'patient_name', 'patient name'],
  phone: ['phone', 'phone_number', 'phone number', 'tel'],
  scheduled_at: ['scheduled_at', 'appointment_date', 'appointment date', 'date', 'datetime'],
  appointment_type: ['appointment_type', 'type', 'appointment type', 'visit_type', 'visit type'],
  provider_name: ['provider_name', 'provider', 'doctor', 'clinician'],
  no_show_count: ['no_show_count', 'no_shows', 'noshows', 'no shows'],
  preferred_language: ['preferred_language', 'language'],
  age: ['age', 'patient_age', 'patient age'],
  condition: ['condition', 'diagnosis', 'patient_condition', 'clinical_context', 'concern'],
};

function mapHeader(header) {
  const h = header.trim().toLowerCase();
  for (const [canonical, variants] of Object.entries(COLUMN_MAP)) {
    if (variants.includes(h)) return canonical;
  }
  return null;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function parseAndIngest(csvBuffer) {
  const lines = [];
  const stream = Readable.from(csvBuffer.toString());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }

  if (lines.length < 2) {
    throw new Error('CSV must have a header row and at least one data row');
  }

  const headers = parseCSVLine(lines[0]).map(mapHeader);
  const results = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((key, idx) => {
      if (key) row[key] = values[idx] || '';
    });

    if (!row.name || !row.phone || !row.scheduled_at || !row.appointment_type) {
      errors.push(`Row ${i + 1}: missing required fields (name, phone, scheduled_at, appointment_type)`);
      continue;
    }

    try {
      const patient = await db.upsertPatient({
        name: row.name,
        phone: row.phone,
        preferred_language: row.preferred_language || 'en',
        no_show_count: parseInt(row.no_show_count || '0', 10) || 0,
        age: row.age ? parseInt(row.age, 10) : null,
      });

      const appointment = await db.upsertAppointment({
        patient_id: patient.id,
        scheduled_at: new Date(row.scheduled_at).toISOString(),
        appointment_type: row.appointment_type,
        provider_name: row.provider_name || null,
        patient_condition: row.condition || null,
      });

      const { score, reason } = scoreAppointment(appointment, patient);
      await db.updateAppointmentRisk(appointment.id, { risk_score: score, risk_reason: reason });

      results.push({
        appointment_id: appointment.id,
        patient_id: patient.id,
        patient_name: patient.name,
        patient_phone: patient.phone,
        scheduled_at: appointment.scheduled_at,
        appointment_type: appointment.appointment_type,
        provider_name: appointment.provider_name,
        risk_score: score,
        risk_reason: reason,
        outreach_status: appointment.outreach_status,
      });

      logger.info({ appointment_id: appointment.id, risk_score: score }, 'csv: appointment ingested');
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
      logger.error({ row: i + 1, err: err.message }, 'csv: row failed');
    }
  }

  // Sort by risk descending
  results.sort((a, b) => b.risk_score - a.risk_score);

  return { appointments: results, errors, total: results.length };
}

module.exports = { parseAndIngest };
