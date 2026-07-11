// Branded HTML/text builders for the two automated transactional emails fired
// off the payment webhook. Approximates (doesn't byte-for-byte port) the
// site's existing client-side buildEmailHtml()/buildInvoiceText() — those
// read from richer in-memory cart/promo state that doesn't all live in the
// `orders`/`order_items` rows this runs against server-side. Same brand
// colours (teal #1F7A8C) and layout shape for consistency.

const ACCENT = '#1F7A8C';
const DARK = '#2C2C2A';
const GREY = '#888780';
const LIGHT = '#E7F2F3';

function money(cur, n) {
  return cur + Number(n || 0).toFixed(2);
}

function itemRowsHtml(items, cur) {
  return (items || []).map((it, i) => {
    const bg = i % 2 === 0 ? '#F9FCFE' : '#ffffff';
    const meta = [it.size, it.color].filter(Boolean).join(' · ');
    return `<tr style="background:${bg}">
      <td style="padding:10px 14px;font-size:13px;color:${DARK};font-weight:600;border-bottom:1px solid ${LIGHT}">${it.product_name || 'Item'}</td>
      <td style="padding:10px 8px;font-size:12px;color:${GREY};border-bottom:1px solid ${LIGHT};white-space:nowrap">${meta || '-'}</td>
      <td style="padding:10px 8px;font-size:12px;color:${GREY};border-bottom:1px solid ${LIGHT};text-align:center">${it.qty || 1}</td>
      <td style="padding:10px 14px;font-size:13px;color:${DARK};font-weight:700;border-bottom:1px solid ${LIGHT};text-align:right;white-space:nowrap">${money(cur, (it.unit_price || 0) * (it.qty || 1))}</td>
    </tr>`;
  }).join('');
}

function baseTemplate({ heading, intro, order, storeName, cur }) {
  const itemsHtml = itemRowsHtml(order.order_items, cur);
  const shipLabel = Number(order.shipping_fee) === 0 ? 'Free / Collection' : money(cur, order.shipping_fee);
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#fff">
    <div style="background:${ACCENT};padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:22px">${storeName}</h1>
    </div>
    <div style="padding:24px 28px">
      <h2 style="margin:0 0 8px;font-size:18px;color:${DARK}">${heading}</h2>
      <p style="font-size:14px;color:${GREY};line-height:1.6">${intro}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr>
          <th style="text-align:left;font-size:11px;color:${GREY};text-transform:uppercase;padding:0 14px 6px">Item</th>
          <th style="text-align:left;font-size:11px;color:${GREY};text-transform:uppercase;padding:0 8px 6px">Options</th>
          <th style="text-align:center;font-size:11px;color:${GREY};text-transform:uppercase;padding:0 8px 6px">Qty</th>
          <th style="text-align:right;font-size:11px;color:${GREY};text-transform:uppercase;padding:0 14px 6px">Price</th>
        </tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <table style="width:100%;margin-top:16px;font-size:13px">
        <tr><td style="padding:4px 0;color:${GREY}">Subtotal</td><td style="padding:4px 0;text-align:right">${money(cur, order.subtotal)}</td></tr>
        ${Number(order.discount) > 0 ? `<tr><td style="padding:4px 0;color:${GREY}">Discount</td><td style="padding:4px 0;text-align:right;color:#2f7a4f">-${money(cur, order.discount)}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:${GREY}">Shipping</td><td style="padding:4px 0;text-align:right">${shipLabel}</td></tr>
        <tr><td style="padding:8px 0;font-weight:700;color:${DARK};border-top:1px solid ${LIGHT}">Total</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${DARK};border-top:1px solid ${LIGHT}">${money(cur, order.total)}</td></tr>
      </table>
      <p style="font-size:12px;color:${GREY};margin-top:20px">Order ${order.order_number} — ${order.first_name || ''} ${order.last_name || ''}</p>
      ${order.notes ? `<p style="font-size:12px;color:${GREY}"><strong>Notes:</strong> ${order.notes}</p>` : ''}
    </div>
  </div>`;
}

export function buildCustomerEmail(order, storeName, cur) {
  const html = baseTemplate({
    heading: 'Thank you for your order!',
    intro: `Hi ${order.first_name || ''}, your payment has been received and your order is confirmed. Every piece is handcrafted to order — we'll be in touch with any updates.`,
    order, storeName, cur
  });
  const text = `Thank you for your order, ${order.first_name || ''}!\nOrder ${order.order_number}\nTotal: ${money(cur, order.total)}\n\nYour payment has been received and your order is confirmed.`;
  return { subject: `Order confirmed — ${order.order_number}`, html, text };
}

export function buildVanishaEmail(order, storeName, cur) {
  const html = baseTemplate({
    heading: 'New paid order!',
    intro: `${order.first_name || ''} ${order.last_name || ''} (${order.email || 'no email'}, ${order.mobile || 'no phone'}) just paid for order ${order.order_number}.`,
    order, storeName, cur
  });
  const text = `New paid order ${order.order_number} from ${order.first_name || ''} ${order.last_name || ''}\nTotal: ${money(cur, order.total)}\nEmail: ${order.email}\nPhone: ${order.mobile}`;
  return { subject: `New order ${order.order_number} — ${money(cur, order.total)}`, html, text };
}
