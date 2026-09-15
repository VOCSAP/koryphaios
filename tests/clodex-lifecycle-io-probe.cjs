const { DatabaseSync } = require("node:sqlite");

const [bundle, operation, databasePath, ...args] = process.argv.slice(2);
const { createSqliteRecordStore } = require(bundle);

async function main() {
  if (!bundle || !operation || !databasePath) throw new Error("Missing SQLite probe arguments");

  if (operation === "prepare") {
    const db = new DatabaseSync(databasePath);
    createSqliteRecordStore(db);
    db.close();
    process.stdout.write("{}\n");
    return;
  }

  if (operation === "round-trip") {
    const db = new DatabaseSync(databasePath);
    const records = createSqliteRecordStore(db);
    await records.write("record", { b: 2, a: 1 });
    await records.write("leases/one", { id: 1 });
    await records.write("leases/two", { id: 2 });
    await records.write("leases-other", { id: 3 });
    const serialized = db.prepare('SELECT "value" FROM clodex_lifecycle_records WHERE "key" = ?').get("record").value;
    const read = await records.read("record");
    const listed = await records.list("leases/");
    await records.remove("leases/two");
    const removed = await records.read("leases/two");
    db.prepare('INSERT INTO clodex_lifecycle_records ("key", "value") VALUES (?, ?)').run("invalid", "not-json");
    db.prepare('INSERT INTO clodex_lifecycle_records ("key", "value") VALUES (?, ?)').run("noncanonical", '{"b":2,"a":1}');
    let invalidReadRejected = false;
    let nonCanonicalReadRejected = false;
    try {
      await records.read("invalid");
    } catch {
      invalidReadRejected = true;
    }
    try {
      await records.read("noncanonical");
    } catch {
      nonCanonicalReadRejected = true;
    }
    db.close();
    process.stdout.write(`${JSON.stringify({ serialized, read, listed, removed, invalidReadRejected, nonCanonicalReadRejected })}\n`);
    return;
  }

  if (operation === "create") {
    const db = new DatabaseSync(databasePath);
    const records = createSqliteRecordStore(db, { busyTimeoutMs: 1_000 });
    const created = await records.createExclusive(args[0], JSON.parse(args[1]));
    db.close();
    process.stdout.write(`${JSON.stringify({ created: Number(created) })}\n`);
    return;
  }

  if (operation === "busy-timeout") {
    const db = new DatabaseSync(databasePath);
    createSqliteRecordStore(db, { busyTimeoutMs: 73 });
    const row = db.prepare("PRAGMA busy_timeout").get();
    db.close();
    process.stdout.write(`${JSON.stringify({ busyTimeoutMs: row.timeout })}\n`);
    return;
  }

  if (operation === "sparse-arrays") {
    const db = new DatabaseSync(databasePath);
    const records = createSqliteRecordStore(db);
    let emptySlotRejected = false;
    let leadingSlotRejected = false;
    try {
      await records.write("empty-slot", new Array(1));
    } catch {
      emptySlotRejected = true;
    }
    try {
      await records.write("leading-slot", [, 1]);
    } catch {
      leadingSlotRejected = true;
    }
    db.close();
    process.stdout.write(`${JSON.stringify({ emptySlotRejected, leadingSlotRejected })}\n`);
    return;
  }

  if (operation === "replacement") {
    const firstDb = new DatabaseSync(databasePath);
    const secondDb = new DatabaseSync(databasePath);
    const first = createSqliteRecordStore(firstDb);
    const second = createSqliteRecordStore(secondDb);
    await first.write("owner", { generation: "original" });
    const observed = await first.read("owner");
    await second.write("owner", { generation: "replacement" });
    const removed = await first.removeIfEquals("owner", observed);
    const remaining = await first.read("owner");
    firstDb.close();
    secondDb.close();
    process.stdout.write(`${JSON.stringify({ removed, remaining })}\n`);
    return;
  }

  if (operation === "contention") {
    const lockDb = new DatabaseSync(databasePath);
    const contenderDb = new DatabaseSync(databasePath);
    const locked = createSqliteRecordStore(lockDb);
    const contender = createSqliteRecordStore(contenderDb, { busyTimeoutMs: 20 });
    await locked.write("owner", { generation: "original" });
    lockDb.exec("BEGIN EXCLUSIVE");
    let rejected = false;
    try {
      await contender.write("owner", { generation: "replacement" });
    } catch {
      rejected = true;
    } finally {
      lockDb.exec("ROLLBACK");
    }
    const remaining = await locked.read("owner");
    lockDb.close();
    contenderDb.close();
    process.stdout.write(`${JSON.stringify({ rejected, remaining })}\n`);
    return;
  }

  throw new Error(`Unknown SQLite probe operation: ${operation}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
