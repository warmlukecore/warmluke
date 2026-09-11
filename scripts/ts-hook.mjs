// Lets a plain `node --experimental-strip-types` script import the app's
// TypeScript directly. TypeScript writes `./types`; Node ESM wants
// `./types.ts`. Nothing else here can unit-test src/lib, and a test that
// only reads source as text would assert the shape of the code rather
// than what it does.
import { register } from "node:module";
register("./ts-hook-resolve.mjs", import.meta.url);
