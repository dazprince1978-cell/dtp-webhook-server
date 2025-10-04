/**
 * DTP Jewelry Auto-SEO + Pricing Webhook Server (v5)
 * --------------------------------------------------
 * Features:
 *  - Auto-SEO (title + meta)
 *  - Auto description rewrite (images stripped, keyword-rich)
 *  - Auto material + type tagging
 *  - Price benchmarking via SerpAPI
 *  - Dual REST/GraphQL variant price update (v2 safe)
 *  - Alt text & collection tagging
 */

import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const SERPAPI = process.env.SERPAPI_KEY;
const API_URL = `https://${SHOP}/admin/api/2024-07`;

function toNum(gid) {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

async function rest(path, method = "GET", body) {
  const res = await fetch(`${API_URL}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return await res.json();
}

// --- SEO Generator ---
function seoFrom(title, material, tags = []) {
  const cleanTitle = title.replace(/\s+\|\s+.*/, "").trim();
  const mat =
    material.includes("s925") ? "S925 Sterling Silver" :
    material.includes("moissanite") ? "Moissanite Gemstone" :
    material.includes("gold") ? "Gold Plated" :
    "Premium Alloy";

  const type =
    (tags.includes("necklaces") && "Necklace") ||
    (tags.includes("bracelet") && "Bracelet") ||
    (tags.includes("earrings") && "Earrings") ||
    (tags.includes("rings") && "Ring") ||
    "Jewelry";

  const seoTitle = `${cleanTitle} | ${mat} ${type} by DTP Jewelry`.slice(0, 60);
  const seoDesc = `${cleanTitle} — ${type} crafted in ${mat}. Hypoallergenic, durable, and gift-ready.`.slice(0, 160);
  return { seoTitle, seoDesc };
}

// --- Description Writer ---
function makeDescription(title, material, type) {
  return `
<p><strong>${title}</strong></p>
<p>This ${type.toLowerCase()} is expertly crafted in ${material}, combining elegance and durability. Designed for daily wear and special occasions alike, it reflects DTP Jewelry’s timeless craftsmanship.</p>
<ul>
  <li>Hypoallergenic and safe for sensitive skin</li>
  <li>Beautifully boxed and ready for gifting</li>
  <li>Designed in London, loved worldwide</li>
</ul>
<p>Care: Wipe clean with a soft cloth. Avoid chemicals and water exposure.</p>
  `.trim();
}

// --- Remove Images from Description ---
function stripImages(html) {
  return html.replace(/<img[^>]*>/gi, "").trim();
}

// --- Variant Price Updater (REST + GraphQL v2 fallback) ---
async function updateVariantPrice(variantGid, newPrice) {
  const idNum = toNum(variantGid);
  try {
    await rest(`variants/${idNum}.json`, "PUT", {
      variant: { id: idNum, price: String(newPrice) },
    });
    console.log(`✔ Variant ${idNum} price updated (REST £${newPrice})`);
  } catch (err) {
    console.warn(`• REST failed, retrying via GraphQL v2...`);
    const q = `
      mutation productVariantUpdateV2($input: ProductVariantInput!) {
        productVariantUpdateV2(input: $input) {
          productVariant { id price }
          userErrors { field message }
        }
      }`;
    const r = await fetch(`${API_URL}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({
        query: q,
        variables: { input: { id: variantGid, price: parseFloat(newPrice) } },
      }),
    });
    const j = await r.json();
    if (j.data?.productVariantUpdateV2?.userErrors?.length)
      throw new Error(JSON.stringify(j.data.productVariantUpdateV2.userErrors));
    console.log(`✔ Variant ${idNum} price updated (GraphQL £${newPrice})`);
  }
}

// --- Price Research via SerpAPI ---
async function fetchCompetitorPrice(title) {
  if (!SERPAPI) return null;
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    title + " necklace jewelry"
  )}&tbm=shop&api_key=${SERPAPI}`;
  const r = await fetch(url);
  const j = await r.json();
  const prices =
    j.shopping_results?.map((p) =>
      parseFloat((p.price || "0").replace(/[^\d.]/g, ""))
    ) || [];
  const avg =
    prices.length > 0
      ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
      : 39;
  return avg;
}

// --- Webhook Handler ---
app.post("/webhook/products/create", async (req, res) => {
  const p = req.body;
  try {
    const title = p.title || "";
    const html = p.body_html || "";
    if (!/necklace|bracelet|ring|earring|jewel/i.test(title)) {
      console.log(`• Skipping enrichment (non-jewelry): ${title}`);
      return res.sendStatus(200);
    }

    console.log(`💎 New product: ${title}`);

    // Infer material
    const lower = title.toLowerCase();
    const material =
      lower.includes("moissanite") ? "s925+moissanite" :
      lower.includes("925") ? "s925+plain" :
      lower.includes("gold") ? "gold+plated" :
      "alloy+stone";

    // Infer type
    const typeMatch =
      /necklace|bracelet|ring|earring/i.exec(title) || ["Jewelry"];
    const type = typeMatch[0];

    // Tags
    const tags = [
      "jewelry",
      type.toLowerCase(),
      material.split("+")[0],
      ...(title.toLowerCase().includes("moissanite") ? ["moissanite"] : []),
      ...(title.toLowerCase().includes("gift") ? ["gift"] : []),
    ];

    // Competitor price lookup
    const avgPrice = await fetchCompetitorPrice(title);
    const finalPrice = Math.round(avgPrice * 1.25 * 100) / 100;

    console.log(`✔ Competitor avg: £${avgPrice} → set £${finalPrice}`);

    // SEO + description
    const { seoTitle, seoDesc } = seoFrom(title, material, tags);
    const desc = stripImages(html) || makeDescription(title, material, type);

    // Update SEO + description
    await rest(`products/${p.id}.json`, "PUT", {
      product: {
        id: p.id,
        body_html: desc,
        tags: tags.join(", "),
        metafields: [
          {
            namespace: "custom",
            key: "material",
            value: material,
            type: "single_line_text_field",
          },
        ],
        seo_title: seoTitle,
        seo_description: seoDesc,
      },
    });

    console.log(`✔ Description + SEO updated`);

    // Update first variant price
    const firstVar = p.variants?.[0];
    if (firstVar) await updateVariantPrice(firstVar.admin_graphql_api_id, finalPrice);

    console.log(`✔ Enrichment complete for "${title}"`);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

app.get("/", (_, res) => res.send("DTP Auto-SEO Server Live"));
app.listen(10000, () => console.log("🚀 Webhook server running on 10000"));
