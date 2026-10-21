// Server-rendered shells; each page fetches its data from the JSON API.
const layout = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ShopLite</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --accent:#1f6f50; --line:#e4e4df; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; gap:16px; align-items:center; padding:12px 16px; background:var(--card); border-bottom:1px solid var(--line); }
  header strong { margin-right:auto; }
  header a { color:var(--accent); text-decoration:none; }
  main { max-width:720px; margin:0 auto; padding:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:10px; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:12px; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--accent); }
  input { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; width:100%; }
  .muted { color:var(--muted); }
  .total { font-size:1.25rem; font-weight:600; }
  #message { min-height:1.5em; }
</style>
</head>
<body>
<header><strong>🛍️ ShopLite</strong><a href="/">Shop</a><a href="/cart">Cart</a><a href="/orders">Orders</a></header>
<main>${body}</main>
<script>
const api = (path, opts = {}) => fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then(async r => ({ ok: r.ok, data: await r.json() }));
const rupees = n => "₹" + n.toLocaleString("en-IN");
${script}
</script>
</body>
</html>`;

const home = layout(
  "Shop",
  `<h1>Products</h1>
<form id="search" class="row" style="margin-bottom:12px">
  <input id="q" name="q" type="search" placeholder="Search products" aria-label="Search products">
  <button type="submit">Search</button>
</form>
<p id="count" class="muted"></p>
<div id="products"></div>
<p id="message" role="status"></p>`,
  `
async function load(q = "") {
  const { data } = await api("/api/products?q=" + encodeURIComponent(q));
  document.getElementById("count").textContent = data.length + " result" + (data.length === 1 ? "" : "s");
  document.getElementById("products").innerHTML = data.map(p =>
    '<div class="card row"><span>' + p.name + ' <span class="muted">' + rupees(p.price) + '</span></span>' +
    '<button data-id="' + p.id + '" aria-label="Add ' + p.name + ' to cart">Add to cart</button></div>').join("");
}
document.getElementById("search").addEventListener("submit", e => { e.preventDefault(); load(document.getElementById("q").value); });
document.getElementById("products").addEventListener("click", async e => {
  const id = e.target.dataset && e.target.dataset.id;
  if (!id) return;
  await api("/api/cart", { method: "POST", body: JSON.stringify({ productId: id }) });
  document.getElementById("message").textContent = "Added to cart";
});
load();`,
);

const cart = layout(
  "Cart",
  `<h1>Your cart</h1>
<div id="lines"></div>
<form id="coupon" class="row" style="margin:12px 0">
  <input id="code" placeholder="Coupon code" aria-label="Coupon code">
  <button type="submit" class="secondary">Apply</button>
</form>
<div class="card">
  <div class="row"><span>Subtotal</span><span id="subtotal">₹0</span></div>
  <div class="row"><span>Discount <span id="couponName" class="muted"></span></span><span id="discount">−₹0</span></div>
  <div class="row total"><span>Total</span><span id="total" data-testid="cart-total">₹0</span></div>
</div>
<button id="place-order" style="width:100%">Place Order</button>
<p id="message" role="status"></p>`,
  `
function render(t) {
  document.getElementById("lines").innerHTML = t.lines.length ? t.lines.map(l =>
    '<div class="card row"><span>' + l.name + '</span>' +
    '<span class="row"><button class="secondary" data-id="' + l.productId + '" data-qty="' + (l.qty - 1) + '" aria-label="Decrease ' + l.name + '">−</button>' +
    '<span aria-label="Quantity of ' + l.name + '">' + l.qty + '</span>' +
    '<button class="secondary" data-id="' + l.productId + '" data-qty="' + (l.qty + 1) + '" aria-label="Increase ' + l.name + '">+</button>' +
    '<span>' + rupees(l.lineTotal) + '</span></span></div>').join("") : '<p class="muted">Your cart is empty.</p>';
  document.getElementById("subtotal").textContent = rupees(t.subtotal);
  document.getElementById("discount").textContent = "−" + rupees(t.discount);
  document.getElementById("couponName").textContent = t.coupon ? "(" + t.coupon + ")" : "";
  document.getElementById("total").textContent = rupees(t.total);
}
const msg = text => document.getElementById("message").textContent = text;
api("/api/cart").then(r => render(r.data));
document.getElementById("lines").addEventListener("click", async e => {
  const d = e.target.dataset;
  if (!d || !d.id) return;
  const r = await api("/api/cart/" + d.id, { method: "PATCH", body: JSON.stringify({ qty: Number(d.qty) }) });
  render(r.data);
});
document.getElementById("coupon").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("/api/coupon", { method: "POST", body: JSON.stringify({ code: document.getElementById("code").value }) });
  if (r.ok) { render(r.data); msg("Coupon applied"); } else msg(r.data.error);
});
document.getElementById("place-order").addEventListener("click", async () => {
  msg("Placing order…");
  const r = await api("/api/orders", { method: "POST" });
  msg(r.ok ? "Order #" + r.data.id + " placed!" : r.data.error);
});`,
);

const orders = layout(
  "Orders",
  `<h1>Your orders</h1><div id="orders"></div>`,
  `
api("/api/orders").then(({ data }) => {
  document.getElementById("orders").innerHTML = data.length ? data.map(o =>
    '<div class="card row"><span>Order #' + o.id + '</span><span>' + rupees(o.total) + '</span></div>').join("")
    : '<p class="muted">No orders yet.</p>';
});`,
);

export const pages: Record<string, string> = { "/": home, "/cart": cart, "/orders": orders };
