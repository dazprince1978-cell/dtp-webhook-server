// server.js — REST-first stable build (SEO + pricing + tags/collections/alt)
// Node 18+
// ENV required: SHOPIFY_SHOP, SHOPIFY_TOKEN
// Optional: SERPAPI_KEY, USD_GBP

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;         // e.g. dtpjewellry.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN;       // Admin API token (shpat_...)
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

if (!SHOP || !TOKEN) {
  console.error("Missing SHOPIFY_SHOP or SHOPIFY_TOKEN env vars.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// ---------- helpers ----------
const clamp = (s, n) => (s || "").toString().trim().replace(/\s+/g, " ").slice(0, n);
const round99 = (n) => (Math.max(0, Math.round(n)) + 0.99).toFixed(2);
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

function seoFrom(title, description) {
  const cleanTitle = clamp((title || "").replace(/\s+\|\s+.*/, ""), 60);
  const metaDesc = clamp(description || "Luxury jewelry by DTP Jewelry.", 160);
  return { title: cleanTitle, description: metaDesc };
}

function inferMaterial(text) {
  const s = (text || "").toLowerCase();
  if (/\bmoissanite\b/.test(s) && (/\bs925\b/.test(s) || /sterling/.test(s))) return "s925+moissanite";
  if (/\bs925\b/.test(s) || /sterling silver/.test(s)) return "s925+plain";
  if (/stainless/.test(s)) return "steel+plain";
  if (/crystal|quartz|agate|stone|amethyst|opal|carnelian|tiger'?s eye/.test(s)) return "alloy+stone";
  if (/alloy|zinc alloy|copper alloy|plated/.test(s)) return "alloy+stone";
  return "alloy+stone";
}

function inferTags(text) {
  const s = (text || "").toLowerCase();
  const tags = new Set(["Jewelry"]);
  if (/necklace/.test(s)) tags.add("necklaces");
  if (/bracelet/.test(s)) tags.add("bracelets");
  if (/earring/.test(s)) tags.add("earrings");
  if (/ring/.test(s)) tags.add("rings");
  if (/tennis/.test(s)) { tags.add("tennis"); tags.add("minimal"); }
  if (/tree of life/.test(s)) { tags.add("tree-of-life"); tags.add("spiritual"); }
  if (/moissanite/.test(s)) tags.add("moissanite");
  if (/\bs925\b|sterling/.test(s)) { tags.add("s925"); tags.add("sterling-silver"); }
  if (/stainless/.test(s)) tags.add("stainless-steel");
  if (/crystal|stone|quartz|agate|opal|amethyst|carnelian|tiger'?s eye/.test(s)) { tags.add("crystal"); tags.add("stone"); tags.add("gift"); }
  return Array.from(tags);
}

function parseLengthMM(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const mm = s.match(/\b(4[0-9]{2}|5[0-9]{2})\s*mm\b/); // 450–599 mm
  if (mm) return parseInt(mm[1], 10);
  const cm = s.match(/\b(4[0-9]|5[0-9])\s*cm\b/);       // 40–59 cm
  if (cm) return parseInt(cm[1], 10) * 10;
  const inch = s.match(/\b(1[6-9]|2[0-2])\s*("|inch|in)\b/); // 16–22"
  if (inch) return Math.round(parseFloat(inch[1]) * 25.4);
  return null;
}

function ladderPriceForMoissanite(mm) {
  if (!mm) return 329.99;
  if (mm <= 460) return 329.99;  // ~18"
  if (mm <= 510) return 349.99;  // ~20"
  return 369.99;                 // ~22"
}

function fallbackPrice(material) {
  if (material === "s925+moissanite") return 329.99;
  if (material === "s925+plain") return 24.99;
  if (material === "steel+plain") return 14.99;
  return 21.99; // alloy+stone default
}

// ---------- competitor pricing ----------
async function fetchCompetitorPrices(query) {
  if (!SERPAPI_KEY) return [];
  const r = await fetch(
    `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=en&gl=uk&api_key=${SERPAPI_KEY}`
  );
  const j = await r.json();
  const out = [];
  for (const it of j.shopping_results || []) {
    const p = it.extracted_price;
    if (p) out.push(p);
  }
  return out.filter((x) => x > 2 && x < 2000);
}
function pickPriceFromCompetitors(prices) {
  if (!prices.length) return null;
  const s = [...prices].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return parseFloat(round99(med * 1.1)); // median +10% premium
}

// ---------- REST helpers ----------
async function rest(path, method = "GET", body = null) {
  const url = `https://${SHOP}/admin/api/2024-07/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return res.json();
}

async function updateProductSEO(productId, title, description) {
  // REST doesn't set SEO meta directly; use GraphQL for SEO only (safe)
  const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
  const seo = { title, description };
  const mutation = `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`;
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query: mutation, variables: { input: { id: productId, seo } } })
  });
  const j = await r.json();
  if (j.errors || j.data?.productUpdate?.userErrors?.length) {
    throw new Error("SEO update failed: " + JSON.stringify(j));
  }
}

async function updateVariantPriceREST(variantGid, price) {
  const numericId = String(variantGid).split("/").pop(); // gid://shopify/ProductVariant/123
  await rest(`variants/${numericId}.json`, "PUT", { variant: { id: Number(numericId), price: String(price) } });
}

async function setAltTextIfMissing(productId, altBase) {
  const data = await rest(`products/${productId}.json`);
  const images = data?.product?.images || [];
  for (const img of images) {
    if (!img.alt || img.alt.trim() === "") {
      await rest(`products/${productId}/images/${img.id}.json`, "PUT", { image: { id: img.id, alt: altBase } });
    }
  }
}

async function addToCollectionIfExists(productId, title) {
  if (!title) return;
  // Find collection by title (custom collections only via REST)
  const col = await rest(`custom_collections.json?title=${encodeURIComponent(title)}&limit=1`);
  const found = col?.custom_collections?.[0];
  if (found?.id) {
    await rest("collects.json", "POST", { collect: { product_id: Number(String(productId).split("/").pop()), collection_id: found.id } });
  }
}

async function setMaterialMetafield(productId, material) {
  await rest("metafields.json", "POST", {
    metafield: {
      owner_id: Number(String(productId).split("/").pop()),
      owner_resource: "product",
      namespace: "dtp",
      key: "material",
      type: "single_line_text_field",
      value: material
    }
  });
}

// ---------- webhook ----------
app.post("/webhook/products/create", async (req, res) => {
  try {
    const p = req.body;
    console.log("➡️ New product:", p.title);

    const rawDesc = (p.body_html || "").toString();
    const desc = clamp(rawDesc.replace(/<[^>]+>/g, " "), 1000);
    const title = p.title || "";
    const combinedText = `${title} ${desc}`;

    // Infer
    const material = inferMaterial(combinedText);
    const tags = uniq([...(p.tags || "").split(",").map(t => t.trim()).filter(Boolean), ...inferTags(combinedText)]);
    const collections = ["Necklaces", ...inferTags(combinedText).includes("moissanite") ? ["Moissanite Jewelry"] : []];

    // Competitor price (optional)
    let benchPrice = null;
    if (SERPAPI_KEY) {
      const prices = await fetchCompetitorPrices(title);
      benchPrice = pickPriceFromCompetitors(prices);
    }

    // 1) SEO
    const { title: seoTitle, description: seoDescription } = seoFrom(title, desc);
    await updateProductSEO(p.admin_graphql_api_id, seoTitle, seoDescription);

    // 2) Tags via REST
    const productIdNum = Number(String(p.admin_graphql_api_id).split("/").pop());
    await rest(`products/${productIdNum}.json`, "PUT", { product: { id: productIdNum, tags: tags.join(", ") } });

    // 3) Variant prices via REST
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const isMoissanite = material === "s925+moissanite";
    for (const v of variants) {
      if (!v?.admin_graphql_api_id) continue;

      let mm = parseLengthMM(v.title) || parseLengthMM(v.option1) || parseLengthMM(v.option2) || parseLengthMM(v.option3);
      let price;
      if (isMoissanite && mm) price = ladderPriceForMoissanite(mm);
      else if (benchPrice) price = benchPrice;
      else price = fallbackPrice(material);

      await updateVariantPriceREST(v.admin_graphql_api_id, price);
    }

    // 4) Metafield + collections + image alts
    await setMaterialMetafield(p.admin_graphql_api_id, material);
    await addToCollectionIfExists(p.admin_graphql_api_id, "Necklaces");
    if (material === "s925+moissanite") await addToCollectionIfExists(p.admin_graphql_api_id, "Moissanite Jewelry");
    await setAltTextIfMissing(p.admin_graphql_api_id, `${seoTitle} by DTP Jewelry`);

    console.log(`✅ Updated "${title}" | material=${material} | tags=${tags.length}`);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

// Optional health check
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on ${PORT}`));

