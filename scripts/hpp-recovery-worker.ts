import { HppSqliteStore } from "../spike/hpp-storage.ts";
const [path, revision, actor, approval, status] = process.argv.slice(2);
if (!path || !revision || !actor || !approval || !status) process.exit(2);
const store = await HppSqliteStore.open(path, `${path}.missing-legacy-json`);
try { console.log(store.release(Number(revision), actor, "ABANDONED_BEFORE_DISPATCH", approval, Date.now(), status)); }
catch { console.log("REJECTED"); }
finally { store.close(); }
