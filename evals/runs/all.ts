// Written by scripts/eval-luke.mjs after every run; not edited by hand. Every
// run file, imported, so the console's Evals page reads them with no database.

import type { EvalRun } from "@/lib/eval-report";
import r0 from "./20261003-1953-before.json";
import r1 from "./20261003-2146-after.json";
import r2 from "./20261004-0535-after2.json";
import r3 from "./20261004-0635-after3.json";
import r4 from "./20261004-1758-after4.json";
import r5 from "./20261004-1811-after5.json";

export const RUN_FILES: Record<string, EvalRun> = {
  "20261003-1953-before.json": r0 as unknown as EvalRun,
  "20261003-2146-after.json": r1 as unknown as EvalRun,
  "20261004-0535-after2.json": r2 as unknown as EvalRun,
  "20261004-0635-after3.json": r3 as unknown as EvalRun,
  "20261004-1758-after4.json": r4 as unknown as EvalRun,
  "20261004-1811-after5.json": r5 as unknown as EvalRun,
};
