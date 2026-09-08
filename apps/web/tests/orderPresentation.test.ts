import assert from "node:assert/strict";
import { formatOrderDate, formatOrderQuantity } from "../src/pages/orderPresentation.js";

assert.equal(formatOrderDate(null), "Não informado");
assert.equal(formatOrderDate("payload-incompleto"), "Não informado");
assert.doesNotThrow(() => formatOrderDate("2026-99-99"));
assert.equal(formatOrderQuantity(null), "Não informado");
assert.equal(formatOrderQuantity(0), "0");

console.log("Orders presentation regression tests passed");
