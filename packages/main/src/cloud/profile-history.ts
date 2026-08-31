import {existsSync} from 'fs';
import {mkdir, readFile, rm, writeFile} from 'fs/promises';
import {join} from 'path';
import sqlite3 from 'sqlite3';

export type CloudHistoryVisit = {
  visit_key?: string;
  url: string;
  title?: string;
  visit_time: string;
  transition: number;
  visit_duration?: string | null;
};

const historyPath = (profileDir: string) => join(profileDir, 'Default', 'History');
const pendingHistoryPath = (profileDir: string) => join(profileDir, 'Default', '.cloak-cloud-history-pending.json');

const openDatabase = (filePath: string, mode: number) => new Promise<sqlite3.Database>((resolve, reject) => {
  new sqlite3.Database(filePath, mode, function (this: sqlite3.Database, error) {
    if (error) reject(error);
    else resolve(this);
  });
});

const all = <T>(database: sqlite3.Database, sql: string, params: unknown[] = []) => new Promise<T[]>((resolve, reject) => {
  database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[]));
});

const get = <T>(database: sqlite3.Database, sql: string, params: unknown[] = []) => new Promise<T | undefined>((resolve, reject) => {
  database.get(sql, params, (error, row) => error ? reject(error) : resolve(row as T | undefined));
});

const run = (database: sqlite3.Database, sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => {
  database.run(sql, params, error => error ? reject(error) : resolve());
});

const close = (database: sqlite3.Database) => new Promise<void>((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

const validVisit = (visit: Partial<CloudHistoryVisit>): visit is CloudHistoryVisit =>
  typeof visit.url === 'string' && Boolean(visit.url) && /^\d{1,20}$/.test(String(visit.visit_time || '')) && Number.isInteger(Number(visit.transition));

export const collectChromiumHistory = async (profileDir: string, afterVisitTime?: string | null) => {
  const filePath = historyPath(profileDir);
  if (!existsSync(filePath)) return {visits: [] as CloudHistoryVisit[], maxVisitTime: afterVisitTime || null};
  const database = await openDatabase(filePath, sqlite3.OPEN_READONLY);
  try {
    const rows = await all<CloudHistoryVisit>(database,
      `select urls.url as url, coalesce(urls.title, '') as title,
              cast(visits.visit_time as text) as visit_time, visits.transition as transition,
              cast(coalesce(visits.visit_duration, 0) as text) as visit_duration
       from visits join urls on urls.id = visits.url
       where visits.visit_time > cast(? as integer)
       order by visits.visit_time asc`,
      [afterVisitTime || '0'],
    );
    const visits = rows.filter(validVisit).map(visit => ({
      url: visit.url,
      title: visit.title || '',
      visit_time: String(visit.visit_time),
      transition: Number(visit.transition || 0),
      visit_duration: visit.visit_duration ? String(visit.visit_duration) : undefined,
    }));
    return {visits, maxVisitTime: visits.at(-1)?.visit_time || afterVisitTime || null};
  } finally {
    await close(database);
  }
};

const readTableColumns = async (database: sqlite3.Database, tableName: string) =>
  new Set((await all<{name: string}>(database, `pragma table_info(${tableName})`)).map(column => column.name));

const applyHistoryVisits = async (filePath: string, visits: CloudHistoryVisit[]) => {
  const database = await openDatabase(filePath, sqlite3.OPEN_READWRITE);
  try {
    const visitColumns = await readTableColumns(database, 'visits');
    const urlColumns = await readTableColumns(database, 'urls');
    if (!visitColumns.has('url') || !visitColumns.has('visit_time') || !urlColumns.has('url')) {
      throw new Error('Chromium History schema is unavailable');
    }
    await run(database, 'begin immediate');
    try {
      for (const visit of visits.filter(validVisit)) {
        const existingUrl = await get<{id: number}>(database, 'select id from urls where url = ?', [visit.url]);
        let urlId = existingUrl?.id;
        if (!urlId) {
          const columns = ['url'];
          const values: unknown[] = [visit.url];
          if (urlColumns.has('title')) { columns.push('title'); values.push(visit.title || ''); }
          if (urlColumns.has('visit_count')) { columns.push('visit_count'); values.push(1); }
          if (urlColumns.has('typed_count')) { columns.push('typed_count'); values.push(0); }
          if (urlColumns.has('last_visit_time')) { columns.push('last_visit_time'); values.push(visit.visit_time); }
          if (urlColumns.has('hidden')) { columns.push('hidden'); values.push(0); }
          await run(database, `insert into urls (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`, values);
          urlId = (await get<{id: number}>(database, 'select id from urls where url = ?', [visit.url]))?.id;
        } else if (urlColumns.has('title') && visit.title) {
          await run(database, 'update urls set title = case when ? <> \'\' then ? else title end where id = ?', [visit.title, visit.title, urlId]);
        }
        if (!urlId) continue;
        const duplicate = await get(database, 'select 1 from visits where url = ? and visit_time = cast(? as integer) and transition = ?', [urlId, visit.visit_time, visit.transition]);
        if (duplicate) continue;
        const columns = ['url', 'visit_time'];
        const values: unknown[] = [urlId, visit.visit_time];
        const add = (column: string, value: unknown) => { if (visitColumns.has(column)) { columns.push(column); values.push(value); } };
        add('from_visit', 0);
        add('transition', visit.transition);
        add('segment_id', 0);
        add('visit_duration', visit.visit_duration || '0');
        add('incremented_omnibox_typed_score', 0);
        add('opener_visit', 0);
        add('originator_visit_id', 0);
        add('external_referrer_url', '');
        await run(database, `insert into visits (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`, values);
        if (urlColumns.has('visit_count')) {
          await run(database, 'update urls set visit_count = coalesce(visit_count, 0) + 1 where id = ?', [urlId]);
        }
        if (urlColumns.has('last_visit_time')) {
          await run(database, 'update urls set last_visit_time = max(coalesce(last_visit_time, 0), cast(? as integer)) where id = ?', [visit.visit_time, urlId]);
        }
      }
      await run(database, 'commit');
    } catch (error) {
      await run(database, 'rollback').catch(() => undefined);
      throw error;
    }
  } finally {
    await close(database);
  }
};

export const restoreChromiumHistory = async (profileDir: string, visits: CloudHistoryVisit[]) => {
  if (!visits.length) return;
  const filePath = historyPath(profileDir);
  if (!existsSync(filePath)) {
    const pendingPath = pendingHistoryPath(profileDir);
    await mkdir(join(profileDir, 'Default'), {recursive: true});
    const existing = existsSync(pendingPath) ? JSON.parse(await readFile(pendingPath, 'utf8')) : [];
    const byKey = new Map<string, CloudHistoryVisit>();
    for (const visit of [...(Array.isArray(existing) ? existing : []), ...visits]) {
      if (validVisit(visit)) byKey.set(`${visit.url}\u0000${visit.visit_time}\u0000${visit.transition}`, visit);
    }
    await writeFile(pendingPath, JSON.stringify([...byKey.values()]), 'utf8');
    return;
  }
  await applyHistoryVisits(filePath, visits);
};

export const restorePendingChromiumHistory = async (profileDir: string) => {
  const pendingPath = pendingHistoryPath(profileDir);
  if (!existsSync(pendingPath) || !existsSync(historyPath(profileDir))) return;
  const visits = JSON.parse(await readFile(pendingPath, 'utf8'));
  if (!Array.isArray(visits)) return;
  await restoreChromiumHistory(profileDir, visits);
  await rm(pendingPath, {force: true});
};
