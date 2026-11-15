import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rulesVersion, surveyVersion, thankYou } from './catalog.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function openStore(file) {
  if (file !== ':memory:') {
    file = resolve(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 2500');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA secure_delete = ON');
  db.exec([
    'CREATE TABLE IF NOT EXISTS responses (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  submission_key TEXT NOT NULL UNIQUE,',
    '  survey_version TEXT NOT NULL,',
    '  rules_version TEXT NOT NULL,',
    '  created_at TEXT NOT NULL,',
    '  answers TEXT NOT NULL CHECK (json_valid(answers)),',
    '  recommendation TEXT NOT NULL CHECK (json_valid(recommendation))',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS responses_version_created ON responses (survey_version, created_at);',
    'CREATE INDEX IF NOT EXISTS responses_created ON responses (created_at);',
  ].join('\n'));

  const insert = db.prepare(
    'INSERT INTO responses (submission_key, survey_version, rules_version, created_at, answers, recommendation) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(submission_key) DO NOTHING ' +
    'RETURNING survey_version, rules_version, answers, recommendation'
  );
  const previous = db.prepare(
    'SELECT survey_version, rules_version, answers, recommendation FROM responses WHERE submission_key = ?'
  );
  const forReport = db.prepare(
    "SELECT created_at, json_remove(answers, '$.comment', '$.name') AS answers, " +
    "json_extract(recommendation, '$.code') AS recommendation_code " +
    'FROM responses WHERE survey_version = ? AND created_at >= ? AND created_at < ?'
  );
  const forManager = db.prepare(
    'SELECT id, survey_version, rules_version, created_at, answers, recommendation FROM responses ' +
    'WHERE (? IS NULL OR id < ?) AND created_at >= ? ORDER BY id DESC LIMIT ?'
  );
  const prune = db.prepare('DELETE FROM responses WHERE created_at < ?');

  return {
    save(submissionId, answers, recommendation, createdAt) {
      const key = createHash('sha256').update(submissionId).digest('hex');
      const encodedAnswers = JSON.stringify(answers);
      const inserted = insert.get(
        key, surveyVersion, rulesVersion, createdAt, encodedAnswers, JSON.stringify(recommendation)
      );
      const row = inserted ?? previous.get(key);
      if (!row || row.survey_version !== surveyVersion || row.answers !== encodedAnswers) {
        return { conflict: true };
      }

      const { rule: _rule, ...publicRecommendation } = JSON.parse(row.recommendation);
      return {
        created: Boolean(inserted),
        receipt: {
          surveyVersion: row.survey_version,
          rulesVersion: row.rules_version,
          thankYou,
          recommendation: publicRecommendation,
        },
      };
    },
    reportRows(from, to) {
      return forReport.all(surveyVersion, from, to).map(row => ({
        createdAt: row.created_at,
        answers: JSON.parse(row.answers),
        recommendationCode: row.recommendation_code,
      }));
    },
    managerPage(before, limit, cutoff) {
      const rows = forManager.all(before, before, cutoff, limit + 1);
      const records = rows.slice(0, limit).map(row => ({
        id: row.id,
        surveyVersion: row.survey_version,
        rulesVersion: row.rules_version,
        createdAt: row.created_at,
        answers: JSON.parse(row.answers),
        recommendation: JSON.parse(row.recommendation),
      }));
      return { records, nextBefore: rows.length > limit ? records.at(-1).id : null };
    },
    pruneBefore(cutoff) {
      return prune.run(cutoff).changes;
    },
    close() {
      db.close();
    },
  };
}
