// One local SQLite authority. No session transcript, provider token or runtime
// process belongs here. Callbacks are synchronous: never hold a DB transaction
// across network/filesystem awaits.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './schema.ts';

export type InstallationState = 'uninitialized' | 'claimed' | 'configuring' | 'ready' | 'recovery';
export interface Installation { id: string; state: InstallationState; authority_epoch: number; revision: number }
export const recoveryRequired = (): Error => Object.assign(
  new Error('Security state requires operator recovery; refusing to initialize a replacement authority.'),
  { code: 'recovery-required' },
);
export const controlError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Only ENOENT denotes an absent legacy file. Corruption never becomes []/{}. */
export function readLegacyJson(file: string): { value: unknown; digest: string } | null {
  let text: string;
  try {
    if (lstatSync(file).isSymbolicLink()) throw recoveryRequired();
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw recoveryRequired();
  }
  try { return { value: JSON.parse(text), digest: digest(text) }; }
  catch { throw recoveryRequired(); }
}

export interface ControlPlane {
  readonly file: string;
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  transaction<T>(work: () => T): T;
  installation(): Installation;
  audit(actor: string, action: string, resource?: string): number;
  bumpEpoch(): void;
  close(): void;
}

export function openControlPlane(opts: { directory: string }): ControlPlane {
  const root = join(opts.directory, 'control-plane');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw recoveryRequired();
  chmodSync(root, 0o700);
  const file = join(root, 'control.sqlite');
  const sentinel = join(root, 'installation.json');
  let newInstance = false;
  let id: string;
  if (!existsSync(sentinel)) {
    if (existsSync(file)) throw recoveryRequired();
    id = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(sentinel, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ version: 1, id }) + '\n');
      fsyncSync(fd);
      newInstance = true;
    } catch { throw recoveryRequired(); }
    finally { if (fd !== undefined) closeSync(fd); }
    const dirFd = openSync(root, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } else {
    const value = readLegacyJson(sentinel)?.value as { version?: unknown; id?: unknown } | undefined;
    if (!value || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw recoveryRequired();
    id = value.id;
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw recoveryRequired();
  }
  let db: DatabaseSync;
  try {
    if (newInstance) closeSync(openSync(file, 'wx', 0o600));
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (integrity.quick_check !== 'ok') throw recoveryRequired();
    if (newInstance) db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT');
    const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{version: number; checksum: string}>;
    for (let i = 0; i < applied.length; i++) {
      if (applied[i]!.version !== i + 1 || !migrations[i] || applied[i]!.checksum !== digest(migrations[i]!)) throw recoveryRequired();
    }
    for (let i = applied.length; i < migrations.length; i++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migrations[i]!);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(i + 1, digest(migrations[i]!), Date.now());
        if (i === 0) db.prepare("INSERT INTO installation(singleton,id,state) VALUES(1,?,'uninitialized')").run(id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const installation = db.prepare('SELECT id FROM installation WHERE singleton=1').get() as {id: string} | undefined;
    if (installation?.id !== id || db.prepare('PRAGMA foreign_key_check').all().length) throw recoveryRequired();
  } catch {
    try { db!.close(); } catch { /* preserve recovery failure */ }
    throw recoveryRequired();
  }
  let depth = 0;
  let closed = false;
  const assertOpen = (): void => { if (closed) throw controlError('unavailable', 'Control plane is closed'); };
  const control: ControlPlane = {
    file,
    get<T>(sql: string, ...params: SQLInputValue[]) { assertOpen(); return db.prepare(sql).get(...params) as T | undefined; },
    all<T>(sql: string, ...params: SQLInputValue[]) { assertOpen(); return db.prepare(sql).all(...params) as T[]; },
    run(sql, ...params) { assertOpen(); if (!depth) throw controlError('invalid-input', 'Control writes must be transactional'); return db.prepare(sql).run(...params); },
    transaction<T>(work: () => T): T {
      assertOpen();
      if (work.constructor.name === 'AsyncFunction') throw controlError('invalid-input', 'Control transactions must be synchronous');
      const nested = depth > 0;
      const savepoint = `control_${depth}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      depth++;
      try {
        const result = work();
        if (result && typeof (result as {then?: unknown}).then === 'function') throw controlError('invalid-input', 'Control transactions must not return promises');
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (e) {
        db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        throw e;
      } finally { depth--; }
    },
    installation() { return control.get<Installation>('SELECT id,state,authority_epoch,revision FROM installation WHERE singleton=1')!; },
    audit(actor, action, resource) {
      if (!depth) throw controlError('invalid-input', 'Audit must commit with its domain mutation');
      const row = control.run('INSERT INTO audit_events(actor_id,action,resource_id,occurred_at_ms,authority_epoch) VALUES(?,?,?,?,?)', actor, action, resource ?? null, Date.now(), control.installation().authority_epoch);
      control.run('INSERT INTO outbox(audit_seq) VALUES(?)', row.lastInsertRowid);
      return Number(row.lastInsertRowid);
    },
    bumpEpoch() {
      if (!depth) throw controlError('invalid-input', 'Epoch changes must be transactional');
      control.run('UPDATE installation SET authority_epoch=authority_epoch+1,revision=revision+1 WHERE singleton=1');
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
  return control;
}
