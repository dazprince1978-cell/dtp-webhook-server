// server.js — DTP webhook server (SEO + pricing + tags/collections/alt)
// Node 18+
// ENV required: SHOPIFY_SHOP, SHOPIFY_TOKEN
// Optional: SERPAPI_KEY, USD_GBP

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;         // e.g. dtpjewellry.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN;       // Admin API token (shpat_...)
const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

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

function inferCollections(text) {
  const s = (text || "").toLowerCase();
  const cols = ["Necklaces"];
  if (/bracelet/.test(s)) cols.push("Bracelets");
  if (/ring/.test(s)) cols.push("Rings");
  if (/earring/.test(s)) cols.push("Earrings");
  if (/moissanite/.test(s)) cols.push("Moissanite Jewelry");
  if (/crystal|stone|quartz|agate|opal|amethyst|carnelian|tiger'?s eye/.test(s)) cols.push("Crystal Jewelry", "Spiritual Jewelry");
  if (/men|unisex/.test(s)) cols.push("Men’s Jewelry");
  return uniq(cols);
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

// ---------- GraphQL ----------
async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const M_PRODUCT_UPDATE = `
mutation($input:ProductInput!){
  productUpdate(input:$input){
    product{ id title }
    userErrors{ field message }
  }
}`;

const M_VARIANT_UPDATE = `
mutation($input:ProductVariantInput!){
  productVariantUpdate(input:$input){
    productVariant{ id price }
    userErrors{ field message }
  }
}`;

const Q_PRODUCT_IMAGES = `
query($id:ID!){
  product(id:$id){
    id
    images(first:100){ nodes{ id altText } }
  }
}`;

const M_IMAGE_UPDATE = `
mutation($id:ID!, $altText:String){
  imageUpdate(id:$id, altText:$altText){
    image{ id altText }
    userErrors{ field message }
  }
}`;

const Q_COLLECTION_BY_TITLE = `
query($q:String!){
  collections(first:1, query:$q){ nodes{ id title } }
}`;

const M_COLLECTION_ADD = `
mutation($collectionId:ID!, $productIds:[ID!]!){
  collectionAddProducts(collectionId:$collectionId, productIds:$productIds){
    userErrors{ field message }
  }
}`;

const M_METAFIELDS_SET = `
mutation($metafields:[MetafieldsSetInput!]!){
  metafieldsSet(metafields:$metafields){
    userErrors{ field message }
  }
}`;

// ---------- competitor pricing ----------
async function fetchCompetitorPrices(query) {
  if (!SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=en&gl=uk&api_key=${SERPAPI_KEY}`;
  const r = await fetch(url);
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
  return parseFloat(round99(med * 1.1)); // median +10% premium, ends .99
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

// ---------- collections ----------
async function ensureCollections(productId, titles) {
  for (const t of titles || []) {
    const q = await gql(Q_COLLECTION_BY_TITLE, { q: `title:${JSON.stringify(t)}` });
    const col = q.collections?.nodes?.[0];
    if (col?.id) {
      await gql(M_COLLECTION_ADD, { collectionId: col.id, productIds: [productId] });
    }
  }
}

// ---------- image alts ----------
async function setAltText(productId, altBase) {
  const q = await gql(Q_PRODUCT_IMAGES, { id: productId });
  const imgs = q.product?.images?.nodes || [];
  for (const img of imgs) {
    const current = (img.altText || "").trim();
    if (!current) {
      await gql(M_IMAGE_UPDATE, { id: img.id, altText: altBase });
    }
  }
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

    // Infer material/tags/collections
    const material = inferMaterial(combinedText);
    const tags = uniq([...(p.tags || "").split(",").map(t => t.trim()).filter(Boolean), ...inferTags(combinedText)]);
    const collections = inferCollections(combinedText);

    // Competitor benchmark
    let benchPrice = null;
    if (SERPAPI_KEY) {
      const compPrices = await fetchCompetitorPrices(title);
      benchPrice = pickPriceFromCompetitors(compPrices);
    }

    // 1) Update product SEO + tags, and set material metafield
    const seo = seoFrom(title, desc);
    await gql(M_PRODUCT_UPDATE, {
      input: {
        id: p.admin_graphql_api_id,
        seo,
        tags
      }
    });

    await gql(M_METAFIELDS_SET, {
      metafields: [
        { namespace: "dtp", key: "material", value: material, type: "single_line_text_field", ownerId: p.admin_graphql_api_id }
      ]
    });

    // 2) Update variant prices
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const isMoissanite = material === "s925+moissanite";
    for (const v of variants) {
      if (!v?.admin_graphql_api_id) continue;

      let mm = null;
      // Try to infer length from variant title/options
      mm = parseLengthMM(v.title) || parseLengthMM(v.option1) || parseLengthMM(v.option2) || parseLengthMM(v.option3);

      let price;
      if (isMoissanite && mm) {
        price = ladderPriceForMoissanite(mm);
      } else if (benchPrice) {
        price = benchPrice;
      } else {
        price = fallbackPrice(material);
      }

      await gql(M_VARIANT_UPDATE, { input: { id: v.admin_graphql_api_id, price: price } });
    }

    // 3) Add to collections if they already exist
    await ensureCollections(p.admin_graphql_api_id, collections);

    // 4) ALT text for images (only if missing)
    const altBase = `${seo.title} by DTP Jewelry`;
    await setAltText(p.admin_graphql_api_id, altBase);

    console.log(`✅ Updated "${title}" | material=${material} | tags=${tags.length} | collections=${collections.length}`);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on ${PORT}`));
