// ShopLite: a tiny online shop.
// State is per browser session (cookie), so parallel visitors and replay runs don't collide.
import { Sentry } from "./instrument.ts";
import { pages } from "./pages.ts";

interface Product {
  id: string;
  name: string;
  price: number;
}
interface CartLine {
  productId: string;
  qty: number;
}
interface Session {
  cart: CartLine[];
  coupon: { code: string; discount: number } | null;
  orders: Array<{ id: number; total: number; items: CartLine[]; at: string }>;
}

const PRODUCTS: Product[] = [
  { id: "shoes", name: "Running Shoes", price: 2000 },
  { id: "tee", name: "Cotton T-Shirt", price: 500 },
  { id: "socks", name: "Sports Socks", price: 200 },
  { id: "cap", name: "Sun Cap", price: 300 },
  { id: "bottle", name: "Steel Water Bottle", price: 400 },
  { id: "glasses", name: "Sun Glasses", price: 900 },
  { id: "hoodie", name: "Cotton Hoodie", price: 1200 },
];
const COUPONS: Record<string, number> = { SAVE10: 0.1 };

let sessions = new Map<string, Session>();
let nextOrderId = 1001;

function getSession(req: Request): { id: string; session: Session; isNew: boolean } {
  const id = req.headers.get("cookie")?.match(/sid=([\w-]+)/)?.[1];
  if (id && sessions.has(id)) return { id, session: sessions.get(id)!, isNew: false };
  const fresh = crypto.randomUUID();
  const session: Session = { cart: [], coupon: null, orders: [] };
  sessions.set(fresh, session);
  return { id: fresh, session, isNew: true };
}

function totals(s: Session) {
  const lines = s.cart.map((l) => {
    const p = PRODUCTS.find((x) => x.id === l.productId)!;
    return { ...l, name: p.name, price: p.price, lineTotal: p.price * l.qty };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = s.coupon?.discount ?? 0;
  return { lines, subtotal, coupon: s.coupon?.code ?? null, discount, total: subtotal - discount };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: Request, s: Session): Promise<Response> {
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health") return json({ ok: true });
  if (route === "POST /__reset") {
    sessions = new Map();
    nextOrderId = 1001;
    return json({ ok: true });
  }

  if (route === "GET /api/products") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return json(PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)));
  }

  if (route === "GET /api/cart") return json(totals(s));
  if (route === "POST /api/cart") {
    const { productId } = (await req.json()) as { productId: string };
    if (!PRODUCTS.some((p) => p.id === productId)) return json({ error: "unknown product" }, 404);
    const line = s.cart.find((l) => l.productId === productId);
    if (line) line.qty += 1;
    else s.cart.push({ productId, qty: 1 });
    return json(totals(s));
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/cart/")) {
    const productId = url.pathname.split("/").pop()!;
    const { qty } = (await req.json()) as { qty: number };
    s.cart = s.cart
      .map((l) => (l.productId === productId ? { ...l, qty: Math.max(0, Math.floor(qty)) } : l))
      .filter((l) => l.qty >= 0); // keep lines visible while quantities change
    return json(totals(s));
  }
  if (route === "POST /api/coupon") {
    const { code } = (await req.json()) as { code: string };
    const rate = COUPONS[code.trim().toUpperCase()];
    if (!rate) return json({ error: "Invalid coupon" }, 400);
    s.coupon = { code: code.trim().toUpperCase(), discount: Math.round(totals(s).subtotal * rate) };
    return json(totals(s));
  }

  if (route === "GET /api/orders") return json(s.orders);
  if (route === "POST /api/orders") {
    if (s.cart.length === 0) return json({ error: "Cart is empty" }, 400);
    await sleep(300); // simulate payment processing
    const order = { id: nextOrderId++, total: totals(s).total, items: s.cart.map((l) => ({ ...l })), at: new Date().toISOString() };
    s.orders.push(order);
    return json(order, 201);
  }

  const page = pages[url.pathname];
  if (req.method === "GET" && page) return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  return json({ error: "not found" }, 404);
}

export async function fetchHandler(req: Request): Promise<Response> {
  const { id, session, isNew } = getSession(req);
  let res: Response;
  try {
    res = await handle(req, session);
  } catch (err) {
    Sentry.withScope((scope) => {
      const url = new URL(req.url);
      scope.setTag("route", `${req.method} ${url.pathname}`);
      scope.setContext("request", { method: req.method, url: req.url });
      Sentry.captureException(err);
    });
    res = json({ error: "Something went wrong" }, 500);
  }
  if (isNew) res.headers.append("set-cookie", `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return res;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: fetchHandler });
  console.log(`ShopLite running on http://localhost:${port}`);
}
