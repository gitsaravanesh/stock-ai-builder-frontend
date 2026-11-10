const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("site/index.html", "utf8");
const script = html.match(/<script>\s*(const CFG=[\s\S]*?)<\/script>/)[1]
  .replace("loadAll();setInterval(loadAll,CFG.refreshMs);", "");

function dashboard(fetch) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: "", innerHTML: "", value: "score",
      classList: { toggle() {} }, addEventListener() {}, querySelectorAll() { return []; }
    });
    return elements.get(id);
  }
  const tabs = ["today", "review", "watchlist"].map(tab => ({
    dataset: { tab }, classList: { toggle() {} }, addEventListener() {}
  }));
  const document = {
    getElementById: element,
    querySelectorAll(selector) { return selector === ".tab" ? tabs : []; },
    querySelector() { return tabs[0]; }
  };
  class DOMParser {
    parseFromString(text) {
      const page = JSON.parse(text);
      const node = textContent => ({ textContent });
      return {
        documentElement: { localName: "ListBucketResult" },
        querySelector() { return null; },
        getElementsByTagName(tag) {
          if (tag === "Contents") return page.keys.map(key => ({
            getElementsByTagName() { return [node(key)]; }
          }));
          if (tag === "IsTruncated") return [node(String(!!page.next))];
          if (tag === "NextContinuationToken") return page.next ? [node(page.next)] : [];
          return [];
        }
      };
    }
  }
  const context = vm.createContext({ document, DOMParser, fetch, URLSearchParams, console });
  vm.runInContext(script, context);
  vm.runInContext('istParts = () => ({year:2026,month:11,day:9,hour:0,minute:16,minutes:16})', context);
  return { context, element, load: () => vm.runInContext("loadAll()", context) };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(data), json: async () => data };
}

test("uses latest report across listing pages and loads review from the same date", async () => {
  const requests = [];
  const app = dashboard(async url => {
    requests.push(url);
    if (url.includes("list-type=2")) {
      return response(url.includes("continuation-token=")
        ? { keys: ["2026/11/06/stock_ai_report.json", "2026/11/06/evaluation.json", "2026/11/10/stock_ai_report.json"] }
        : { keys: ["2026/11/05/stock_ai_report.json", "2026/11/08/evaluation.json"], next: "next page" });
    }
    if (url.includes("stock_ai_report.json")) return response({ stocks: [{ ticker: "ABC", score: 80 }] });
    if (url.includes("evaluation.json")) return response({ results: [{ ticker: "ABC", actual: 1 }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  await app.load();
  assert.match(app.element("dataNoticeTitle").textContent, /6 November 2026/);
  assert.equal(app.element("heroTitle").textContent, "Latest prediction");
  assert.match(app.element("reviewMeta").textContent, /8 November 2026/);
  assert.match(app.element("reviewTitle").textContent, /Previous day's/);
  assert.equal(requests.filter(url => url.includes("continuation-token=")).length, 1);
  assert.ok(requests.filter(url => url.includes("stock_ai_report.json")).every(url => url.includes("/2026/11/06/")));
  assert.ok(requests.some(url => url.includes("/2026/11/08/evaluation.json")));
  assert.ok(!requests.some(url => url.includes("/2026/11/06/evaluation.json")));
});

test("prefers today's report and does not request absent optional files", async () => {
  const requests = [];
  const app = dashboard(async url => {
    requests.push(url);
    return url.includes("list-type=2")
      ? response({ keys: ["2026/11/06/stock_ai_report.json", "2026/11/09/stock_ai_report.json"] })
      : response({ stocks: [{ ticker: "ABC" }] });
  });
  await app.load();
  assert.equal(app.element("heroTitle").textContent, "Today's prediction");
  assert.match(app.element("globalMessage").textContent, /9 November 2026/);
  assert.equal(requests.length, 2);
});

test("handles no reports and rejects invalid or future dates", async () => {
  const app = dashboard(async () => response({ keys: [
    "2026/02/30/stock_ai_report.json", "2026/11/10/stock_ai_report.json"
  ] }));
  await app.load();
  assert.equal(app.element("globalMessage").textContent, "No report found on or before today.");
});

test("shows actual close, predicted direction, and direction result", async () => {
  const app = dashboard(async url => url.includes("list-type=2")
    ? response({ keys: ["2026/11/09/stock_ai_report.json", "2026/11/09/evaluation.json"] })
    : url.includes("evaluation.json")
      ? response({ results: [
          { ticker: "ABC", predicted_direction: "UP", actual_close: 512.5, direction_correct: true },
          { ticker: "XYZ", predicted_direction: "DOWN", actual_close: 88, direction_correct: false }
        ] })
      : response({ stocks: [{ ticker: "ABC" }] }));
  app.context.istParts = () => ({ year: 2026, month: 11, day: 9, hour: 16, minute: 0, second: 0, minutes: 960 });
  await app.load();
  const table = app.element("reviewTable").innerHTML;
  assert.match(table, /Predicted direction/);
  assert.match(table, /Actual close/);
  assert.match(table, /UP/);
  assert.match(table, /512\.50/);
  assert.match(table, /Correct/);
  assert.match(table, /Incorrect/);
});

test("keeps today's evaluation hidden until the 4:00 PM close", async () => {
  const requests = [];
  const app = dashboard(async url => {
    requests.push(url);
    if (url.includes("list-type=2")) return response({ keys: [
      "2026/11/08/evaluation.json", "2026/11/09/stock_ai_report.json", "2026/11/09/evaluation.json"
    ] });
    if (url.includes("/2026/11/08/evaluation.json")) return response({ results: [{ ticker: "OLD", predicted_direction: "UP", actual_close: 10, direction_correct: true }] });
    if (url.includes("evaluation.json")) return response({ results: [{ ticker: "NEW", predicted_direction: "DOWN", actual_close: 20, direction_correct: false }] });
    return response({ stocks: [{ ticker: "ABC" }] });
  });
  await app.load();
  assert.ok(requests.some(url => url.includes("/2026/11/08/evaluation.json")));
  assert.ok(!requests.some(url => url.includes("/2026/11/09/evaluation.json")));
  assert.equal(app.element("heroTitle").textContent, "Today's prediction");
  assert.match(app.element("reviewMeta").textContent, /Previous session: Sunday, 8 November 2026/);
  assert.match(app.element("reviewTable").innerHTML, /OLD/);
});

test("shows today's evaluation from the 4:00 PM close", async () => {
  const requests = [];
  const app = dashboard(async url => {
    requests.push(url);
    if (url.includes("list-type=2")) return response({ keys: [
      "2026/11/08/evaluation.json", "2026/11/09/stock_ai_report.json", "2026/11/09/evaluation.json"
    ] });
    if (url.includes("/2026/11/09/evaluation.json")) return response({ generated_at: "16:10 IST", results: [{ ticker: "NEW", predicted_direction: "DOWN", actual_close: 20, direction_correct: false }] });
    return response({ stocks: [{ ticker: "ABC" }] });
  });
  app.context.istParts = () => ({ year: 2026, month: 11, day: 9, hour: 16, minute: 0, second: 0, minutes: 960 });
  await app.load();
  assert.ok(requests.some(url => url.includes("/2026/11/09/evaluation.json")));
  assert.ok(!requests.some(url => url.includes("/2026/11/08/evaluation.json")));
  assert.equal(app.element("reviewTitle").textContent, "Today's prediction performance");
  assert.match(app.element("reviewMeta").textContent, /9 November 2026/);
  assert.match(app.element("reviewTable").innerHTML, /NEW/);
});

test("shows permission errors instead of treating them as missing reports", async () => {
  const app = dashboard(async () => response({}, 403));
  await app.load();
  assert.match(app.element("globalMessage").textContent, /HTTP 403/);
});
