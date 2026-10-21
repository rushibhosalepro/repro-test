// No Repro browser runner. It runs on the repo owner's own GitHub Actions runner (copied into
// their repo as .github/norepro/runner.mjs), never on No Repro's servers.
//   node runner.mjs <job.json> <out.json>
// job: { mode: "snapshot" | "replay", baseUrl, reset: "POST /__reset" | null, runs, plan: { viewport, steps, check } }
// Replay: run the steps `runs` times in fresh browsers and evaluate the check each time. If a step
// can't be performed, the page is described (elements, text) so No Repro can correct the plan.
// Snapshot: run the steps once, then describe the page.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const CANDIDATES = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[data-testid],[id]';
const MAX_ELEMENTS = 60;

export function countRequests(requests, method, path) {
  return requests.filter((r) => r.method === method.toUpperCase() && r.path === path).length;
}

/** Checks that don't need the live page. Returns null when the page is needed. */
export function evaluateOffline(check, observed) {
  if (check.type === "request_count") {
    const n = countRequests(observed.requests, check.method, check.path);
    return { passed: n <= check.max, detail: `${check.method.toUpperCase()} ${check.path} was sent ${n} time${n === 1 ? "" : "s"} (expected at most ${check.max})` };
  }
  if (check.type === "no_errors") {
    return observed.errors.length
      ? { passed: false, detail: `${observed.errors.length} error${observed.errors.length === 1 ? "" : "s"}: ${observed.errors[0]}` }
      : { passed: true, detail: "no errors" };
  }
  return null;
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function locate(page, t) {
  let loc =
    t.by === "role" ? page.getByRole(t.role ?? "button", { name: t.value, exact: true })
    : t.by === "label" ? page.getByLabel(t.value, { exact: true })
    : t.by === "placeholder" ? page.getByPlaceholder(t.value, { exact: true })
    : t.by === "testId" ? page.getByTestId(t.value)
    : t.by === "text" ? page.getByText(t.value, { exact: true })
    : page.locator(t.value);
  if (t.nth !== null && t.nth !== undefined) loc = loc.nth(t.nth);
  return loc;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

async function runStep(page, step, baseUrl) {
  const opts = { timeout: 5000 };
  switch (step.do) {
    case "goto":
      await page.goto(new URL(step.path, baseUrl).toString(), { timeout: 15000 });
      break;
    case "click": {
      const loc = locate(page, step.target);
      for (let i = 0; i < step.times; i++) await loc.click({ ...opts, noWaitAfter: step.times > 1 });
      break;
    }
    case "fill":
      await locate(page, step.target).fill(step.value, opts);
      break;
    case "press":
      await locate(page, step.target).press(step.key, opts);
      break;
    case "select":
      await locate(page, step.target).selectOption(step.value, opts);
      break;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms, 3000));
      break;
  }
  await settle(page);
}

function instrument(page, origin) {
  const observed = { requests: [], errors: [] };
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin) return;
    // Everything the app itself sends (API calls, form posts); plain page loads aren't interesting.
    const pageLoad = r.resourceType() === "document" && r.method() === "GET";
    if (!pageLoad) observed.requests.push({ method: r.method(), path: u.pathname });
  });
  page.on("response", (r) => {
    if (r.status() >= 500) observed.errors.push(`${r.request().method()} ${new URL(r.url()).pathname} returned ${r.status()}`);
  });
  page.on("console", (m) => m.type() === "error" && observed.errors.push(`console: ${squash(m.text()).slice(0, 200)}`));
  page.on("pageerror", (e) => observed.errors.push(`uncaught: ${squash(e.message).slice(0, 200)}`));
  return observed;
}

async function sameElement(page, loc, handle) {
  try {
    if ((await loc.count()) !== 1) return false;
    const other = await loc.elementHandle({ timeout: 500 });
    return other ? await page.evaluate(([a, b]) => a === b, [other, handle]) : false;
  } catch {
    return false;
  }
}

/** Visible elements, each with a locator that's been checked to find exactly that element. */
async function describeElements(page) {
  const handles = await page.$$(CANDIDATES);
  const out = [];
  for (const h of handles) {
    if (out.length >= MAX_ELEMENTS) break;
    if (!(await h.isVisible().catch(() => false))) continue;
    const info = await h.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const explicitRole = el.getAttribute("role");
      const implicit =
        tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type)) ? "button"
        : tag === "a" ? "link"
        : tag === "select" ? "combobox"
        : tag === "textarea" ? "textbox"
        : tag === "input" && type === "checkbox" ? "checkbox"
        : tag === "input" && type === "radio" ? "radio"
        : tag === "input" && type === "search" ? "searchbox"
        : tag === "input" ? "textbox"
        : null;
      const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
      const text = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
      return {
        tag,
        role: explicitRole || implicit,
        ariaLabel: el.getAttribute("aria-label"),
        label: labelEl ? labelEl.innerText.replace(/\s+/g, " ").trim() : null,
        placeholder: el.getAttribute("placeholder"),
        testId: el.getAttribute("data-testid"),
        id: el.id || null,
        text: text.slice(0, 80),
        value: tag === "input" || tag === "textarea" ? el.value : null,
      };
    });
    const name = info.ariaLabel || info.label || (info.role === "button" || info.role === "link" ? info.text : null) || info.placeholder;
    const tries = [];
    if (info.role && name) tries.push({ by: "role", value: name, role: info.role, nth: null });
    if (info.testId) tries.push({ by: "testId", value: info.testId, role: null, nth: null });
    if (info.label) tries.push({ by: "label", value: info.label, role: null, nth: null });
    if (info.placeholder) tries.push({ by: "placeholder", value: info.placeholder, role: null, nth: null });
    if (info.id) tries.push({ by: "css", value: `#${info.id.replace(/([^\w-])/g, "\\$1")}`, role: null, nth: null });
    if (!info.role && info.text) tries.push({ by: "text", value: info.text, role: null, nth: null });
    let target = null;
    for (const t of tries) {
      if (await sameElement(page, locate(page, t), h)) {
        target = t;
        break;
      }
    }
    if (!target) continue; // can't address it reliably, so don't offer it
    out.push({
      ref: `e${out.length + 1}`,
      kind: info.role ?? info.tag,
      name: name ?? info.text ?? "",
      text: info.text,
      value: info.value,
      target,
    });
  }
  return out;
}

async function resetApp(baseUrl, reset) {
  if (!reset) return;
  const [method, path] = reset.split(" ");
  await fetch(new URL(path, baseUrl), { method }).catch(() => {});
}

async function oneRun(browser, job, withSnapshot, runIndex) {
  const origin = new URL(job.baseUrl).origin;
  const context = await browser.newContext({ viewport: job.plan.viewport, hasTouch: job.plan.viewport.width < 600 });
  const page = await context.newPage();
  const observed = instrument(page, origin);
  const result = { ok: true, failedStep: null, error: null };
  try {
    for (let i = 0; i < job.plan.steps.length; i++) {
      try {
        await runStep(page, job.plan.steps[i], job.baseUrl);
      } catch (err) {
        Object.assign(result, { ok: false, failedStep: i, error: squash(err.message).slice(0, 300) });
        break;
      }
    }
    if (withSnapshot || !result.ok) {
      result.url = new URL(page.url()).pathname;
      result.title = await page.title().catch(() => "");
      result.text = squash(await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 2500);
      result.elements = await describeElements(page);
    }
    if (result.ok && job.plan.check) {
      let verdict = evaluateOffline(job.plan.check, observed);
      if (!verdict) {
        const c = job.plan.check;
        if (c.type === "text_visible") {
          const seen = await page.getByText(c.text).first().isVisible({ timeout: 2000 }).catch(() => false);
          verdict = { passed: seen, detail: seen ? `the page shows "${c.text}"` : `the page doesn't show "${c.text}"` };
        } else {
          const shown = squash(await locate(page, c.target).innerText({ timeout: 3000 }).catch(() => ""));
          const passed = shown.includes(squash(c.expected));
          verdict = { passed, detail: passed ? `shows "${shown}"` : `shows "${shown || "nothing"}" instead of "${c.expected}"` };
        }
      }
      result.check = verdict;
    }
    if (runIndex !== null) {
      await mkdir("/tmp/norepro", { recursive: true });
      await page.screenshot({ path: `/tmp/norepro/run-${runIndex}.png` }).catch(() => {});
    }
  } finally {
    result.requests = observed.requests;
    result.errors = observed.errors;
    await context.close();
  }
  return result;
}

async function main() {
  const [jobPath, outPath] = process.argv.slice(2);
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    let out;
    if (job.mode === "snapshot") {
      await resetApp(job.baseUrl, job.reset);
      out = await oneRun(browser, job, true, null);
    } else {
      out = { runs: [] };
      for (let i = 1; i <= job.runs; i++) {
        await resetApp(job.baseUrl, job.reset);
        const run = await oneRun(browser, job, false, i);
        out.runs.push(run);
        // If the steps can't be followed, repeating them won't help; report what the page looked like.
        if (!run.ok) break;
      }
    }
    await writeFile(outPath, JSON.stringify(out));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main().catch(async (err) => {
    await writeFile(process.argv[3], JSON.stringify({ fatal: String(err?.message ?? err) })).catch(() => {});
    process.exitCode = 1;
  });
}
