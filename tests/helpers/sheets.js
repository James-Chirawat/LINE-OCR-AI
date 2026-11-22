import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const source = readFileSync(new URL("../../apps-script/Code.gs", import.meta.url), "utf8");

class Sheet {
  rows = [];
  notes = new Map();
  maxRows = 100;
  getLastRow() { return this.rows.length; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, count) { this.maxRows += count; }
  setFrozenRows() {}

  moveColumns(range, destination) {
    const column = range.getColumn();
    for (const row of this.rows) {
      const [value] = row.splice(column - 1, 1);
      row.splice(destination - 1, 0, value);
    }
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    const read = (i, j) => this.rows[i - 1]?.[j - 1] ?? "";
    const write = (i, j, value) => {
      if (this.failStatus && j === 4 && value === "Confirmed") {
        this.failStatus = false;
        throw new Error("simulated failure updating status");
      }
      if (typeof value === "string") {
        if (value.startsWith("=")) throw new Error("unexpected formula");
        if (value.startsWith("'")) value = value.slice(1);
      }
      this.rows[i - 1] ??= [];
      this.rows[i - 1][j - 1] = value;
    };
    const key = row + ":" + column;
    return {
      getColumn: () => column,
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
      setNumberFormats() { return this; },
      getNote: () => this.notes.get(key) || "",
      setNote: (value) => this.notes.set(key, value),
      getValue: () => read(row, column),
      setValue: (value) => write(row, column, value),
      getValues: () => Array.from({ length: rowCount }, (_, i) =>
        Array.from({ length: columnCount }, (_, j) => read(row + i, column + j))),
      setValues(values) {
        values.forEach((cells, i) =>
          cells.forEach((value, j) => write(row + i, column + j, value)));
        return this;
      },
      createTextFinder(value) {
        return {
          matchEntireCell() { return this; },
          matchCase() { return this; },
          findNext() { return this.findAll()[0] || null; },
          findAll() {
            const matches = [];
            for (let i = row; i < row + rowCount; i++) {
              if (read(i, column) === value) matches.push({ getRow: () => i });
            }
            return matches;
          },
        };
      },
    };
  }
}

export function createScriptSandbox(secret, now) {
  const tabs = {};
  const book = {
    getSheetByName: (name) => tabs[name],
    insertSheet: (name) => tabs[name] = new Sheet(),
  };
  let locked = false;
  const lock = {
    tryLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    waitLock() { if (!this.tryLock()) throw new Error("locked"); },
    releaseLock() { locked = false; },
  };
  const script = vm.createContext({
    Date: class extends Date {
      static now() { return now(); }
      constructor(...args) { super(...(args.length ? args : [now()])); }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => ({ SHARED_SECRET: secret, SPREADSHEET_ID: "fixture" })[key],
      }),
    },
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      computeHmacSha256Signature: (body, key) =>
        [...createHmac("sha256", key).update(body).digest()].map((byte) => (byte << 24) >> 24),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (body) => ({
        setMimeType: (type) => new Response(body, { headers: { "Content-Type": type } }),
      }),
    },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: {
      openById: () => {
        if (!locked) throw new Error("spreadsheet opened without lock");
        return book;
      },
      flush() { if (!locked) throw new Error("flush without lock"); },
    },
  });
  vm.runInContext(source, script);
  script.setupSheets();
  return { tabs, setup: () => script.setupSheets(), receive: (body) => script.doPost({ postData: { contents: body } }) };
}
