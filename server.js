// server.js — DTP Auto Enrichment v3
// Unique SEO + full on-page description + pricing + tags + collections + image ALT
// Variant pricing: REST first, GraphQL fallback
// Env: SHOPIFY_SHOP, SHOPIFY_TOKEN, (optional) SERPAPI_KEY, USD_GBP

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;          // e.g. dtpjewellry.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN;        // shpat_...
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

if (!SHOP || !TOKEN) {
  console.error("❌ Missing SHOPIFY_SHOP or SHOPIFY_TOKEN.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// ───────── helpers ─────────
const clamp = (s, n) => (s || "").toString().trim().replace(/\s+/g, " ").slice(0, n);
const round99 = (n) => (Math.max(0, Math.round(n)) + 0.99).toFixed(2);
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
const toNumericId = (gid) => (gid ? String(gid).split("/").pop() : null);

// lightweight keyword sets
const JEWELRY_WORDS = /(necklace|pendant|chain|bracelet|earrings?|ring|anklet|choker|tennis)/i;
const ELECTRONICS_WORDS = /(iphone|samsung|pixel|galaxy|airpods|ps5|xbox|laptop|camera|tablet|phone)/i;
const STONE_WORDS =
  /(moissanite|amethyst|opal|agate|carnelian|rose quartz|quartz|tiger'?s eye|onyx|malachite|turquoise|zircon|cubic zirconia|cz|crystal)/i;

function inferStone(text) {
  const m = (text || "").toLowerCase().match(STONE_WORDS);
  if (!m) return null;
  const s = m[0];
  // normalize
  if (s === "cz" || s === "cubic zirconia") return "Cubic Zirconia";
  if (/tiger/.test(s)) return "Tiger’s Eye";
  if (/rose quartz/.test(s)) return "Rose Quartz";
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function inferMaterial(text) {
  const s = (text || "").toLowerCase();
  if (/\bmoissanite\b/.test(s) && (/\bs925\b/.test(s) || /sterling/.test(s))) return "s925+moissanite";
  if (/\bs925\b/.test(s) || /sterling silver/.test(s)) return "s925+plain";
  if (/stainless/.test(s)) return "steel+plain";
  if (/alloy|zinc alloy|copper alloy|plated|crystal|quartz|agate|amethyst|opal|stone|carnelian|tiger'?s eye|onyx|turquoise/.test(s))
    return "alloy+stone";
  return "alloy+stone";
}

function inferType({ title, product_type, tagsText }) {
  const s = `${title || ""} ${product_type || ""} ${tagsText || ""}`;
  if (/bracelet/i.test(s)) return "Bracelet";
  if (/earrings?/i.test(s)) return "Earrings";
  if (/rings?/i.test(s)) return "Ring";
  if (/anklet/i.test(s)) return "Anklet";
  if (/choker/i.test(s)) return "Choker";
  if (/pendant/i.test(s)) return "Pendant Necklace";
  if (/chain/i.test(s)) return "Chain Necklace";
  if (/tennis/i.test(s)) return "Tennis Necklace";
  if (/necklace/i.test(s)) return "Necklace";
  return "Jewelry";
}

function parseLengthMM(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const mm = s.match(/\b(4[0-9]{2}|5[0-9]{2})\s*mm\b/); if (mm) return parseInt(mm[1], 10);
  const cm = s.match(/\b(4[0-9]|5[0-9])\s*cm\b/);       if (cm) return parseInt(cm[1], 10) * 10;
  const inch = s.match(/\b(1[6-9]|2[0-2])\s*("|inch|in)\b/); if (inch) return Math.round(parseFloat(inch[1]) * 25.4);
  return null;
}

function ladderPriceForMoissanite(mm) {
  if (!mm) return 329.99;
  if (mm <= 460) return 329.99;   // ~18"
  if (mm <= 510) return 349.99;   // ~20"
  return 369.99;                  // ~22"
}

function fallbackPrice(material) {
  if (material === "s925+moissanite") return 329.99;
  if (material === "s925+plain") return 24.99;
  if (material === "steel+plain") return 14.99;
  return 21.99; // alloy+stone
}

function inferTags(text) {
  const s = (text || "").toLowerCase();
  const tags = new Set(["Jewelry"]);
  if (/necklace/.test(s)) tags.add("necklaces");
  if (/bracelet/.test(s)) tags.add("bracelets");
  if (/earrings?/.test(s)) tags.add("earrings");
  if (/ring/.test(s)) tags.add("rings");
  if (/tennis/.test(s)) { tags.add("tennis"); tags.add("minimal"); }
  if (/tree of life/.test(s)) { tags.add("tree-of-life"); tags.add("spiritual"); }
  if (/moissanite/.test(s)) tags.add("moissanite");
  if (/\bs925\b|sterling/.test(s)) { tags.add("s925"); tags.add("sterling-silver"); }
  if (/stainless/.test(s)) tags.add("stainless-steel");
  if (STONE_WORDS.test(s)) { tags.add("crystal"); tags.add("stone"); tags.add("gift"); }
  return Array.from(tags);
}

// UNIQUE SEO generator
function seoFrom({ title, description, material, type, stone }) {
  const cleanTitle = (title || "").replace(/\s+\|\s+.*/, "").trim();

  const materialLabel =
    material === "s925+moissanite" ? "Moissanite in S925 Sterling Silver" :
    material === "s925+plain"      ? "S925 Sterling Silver" :
    material === "steel+plain"     ? "Stainless Steel" :
                                     "Crystal & Alloy";

  const stoneBit = stone ? `${stone} ` : "";

  let hook = "Hypoallergenic, durable and gift-ready.";
  if (stone && /moissanite/i.test(stone)) hook = "Brilliant sparkle that rivals diamonds.";
  else if (/spiritual/i.test(description || "")) hook = "Symbolic design for balance and energy.";
  else if (/tennis/i.test(title || "")) hook = "Sleek, modern line with everyday shine.";

  const seoTitle = clamp(`${cleanTitle} | ${stoneBit}${materialLabel} by DTP Jewelry`, 60);
  const seoDescription = clamp(`${cleanTitle} — ${type} crafted in ${stoneBit}${materialLabel}. ${hook}`, 160);
  return { title: seoTitle, description: seoDescription };
}

// Generate a unique on-page description (HTML)
function buildProductHTML({ title, type, material, stone, lengthOptionsMM = [] }) {
  const materialLabel =
    material === "s925+moissanite" ? "S925 sterling silver with moissanite" :
    material === "s925+plain"      ? "solid S925 sterling silver" :
    material === "steel+plain"     ? "stainless steel" :
                                     "durable alloy with polished finish";

  const stoneLine = stone ? `${stone} stone` : `high-polish finish`;

  const sizes =
    lengthOptionsMM.length
      ? `Available lengths: ${lengthOptionsMM.map(mm => {
          const inches = Math.round(mm / 25.4);
          return `${mm}mm (${inches}″)`;
        }).join(", ")}.`
      : "";

  const whyBullets = [
    stone && /moissanite/i.test(stone) ? "Diamond-like brilliance with excellent fire" : null,
    material === "s925+plain" ? "Hypoallergenic and safe for sensitive skin" : null,
    /necklace|pendant|chain/i.test(type) ? "Versatile design for everyday and occasion wear" : "Polished finish with comfortable wear",
    "Gift-ready presentation"
  ].filter(Boolean);

  return `
<p><strong>${title}</strong> — a ${type.toLowerCase()} crafted from ${materialLabel} with ${stoneLine}. A refined piece that elevates everyday style and shines for special occasions.</p>

<p><strong>Why you’ll love it</strong></p>
<ul>
  ${whyBullets.map(b => `<li>${b}</li>`).join("\n")}
</ul>

<p><strong>Details</strong></p>
<ul>
  <li>Material: ${materialLabel}</li>
  ${stone ? `<li>Stone: ${stone}</li>` : ""}
  ${sizes ? `<li>${sizes}</li>` : ""}
  <li>Closure & fit: designed for secure, comfortable wear</li>
</ul>

<p><strong>Care</strong></p>
<p>Wipe with a soft dry cloth after wear. Store separately to protect the finish and setting.</p>
`;
}

// ───────── competitor pricing (optional) ─────────
async function fetchCompetitorPrices(query) {
  if (!SERPAPI_KEY) return [];
  const r = await fetch(
    `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=en&gl=uk&api_key=${SERPAPI_KEY}`
  );
  const j = await r.json();
  const out = [];
  for (const it of (j.shopping_results || [])) {
    const p = it.extracted_price;
    if (p) out.push(p);
  }
  return out.filter((x) => x > 2 && x < 2000);
}
function pickPriceFromCompetitors(prices) {
  if (!prices.length) return null;
  const s = [...prices].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return parseFloat(round99(med * 1.1));
}

// ───────── REST + GraphQL helpers ─────────
async function rest(path, method = "GET", body = null) {
  const url = `https://${SHOP}/admin/api/2024-07/${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return res.json();
}

// SEO via GraphQL
async function updateProductSEO(productGid, title, description) {
  const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
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
    body: JSON.stringify({ query: mutation, variables: { input: { id: productGid, seo: { title, description } } } })
  });
  const j = await r.json();
  const errs = j.errors || j.data?.productUpdate?.userErrors || [];
  if (errs.length) console.error("❌ SEO update failed:", JSON.stringify(errs));
  else console.log("   ✔ SEO updated:", title, "|", description);
}

// Variant pricing: REST first, GraphQL fallback
async function updateVariantPrice(variantGid, price) {
  const idNum = Number(toNumericId(variantGid));
  try {
    await rest(`variants/${idNum}.json`, "PUT", { variant: { id: idNum, price: String(price) } });
    console.log(`   ✔ Variant ${idNum} (REST) -> £${price}`);
    return;
  } catch (e) {
    const msg = String(e.message || e);
    if (!/404/.test(msg)) throw e;
    console.warn(`   • REST 404 for variant ${idNum}, trying GraphQL…`);
  }

  const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
  const mutation = `
    mutation($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant { id price }
        userErrors { field message }
      }
    }`;
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query: mutation, variables: { input: { id: variantGid, price: parseFloat(price) } } })
  });
  const j = await r.json();
  const errs = j.errors || j.data?.productVariantUpdate?.userErrors || [];
  if (errs.length) throw new Error("GraphQL variant update failed: " + JSON.stringify(errs));
  console.log(`   ✔ Variant ${idNum} (GraphQL) -> £${price}`);
}

async function setAltTextIfMissing(productGid, altBase) {
  const productId = Number(toNumericId(productGid));
  const data = await rest(`products/${productId}.json`);
  const images = data?.product?.images || [];
  for (const img of images) {
    if (!img.alt || img.alt.trim() === "") {
      await rest(`products/${productId}/images/${img.id}.json`, "PUT", { image: { id: img.id, alt: altBase } });
      console.log(`   ✔ ALT text set for image ${img.id}`);
    }
  }
}

async function addToCollectionIfExists(productGid, title) {
  const productId = Number(toNumericId(productGid));
  const col = await rest(`custom_collections.json?title=${encodeURIComponent(title)}&limit=1`);
  const found = col?.custom_collections?.[0];
  if (found?.id) {
    await rest("collects.json", "POST", { collect: { product_id: productId, collection_id: found.id } });
    console.log(`   ✔ Added to collection: ${title}`);
  }
}

async function setMaterialMetafield(productGid, material) {
  const owner_id = Number(toNumericId(productGid));
  await rest("metafields.json", "POST", {
    metafield: {
      owner_id,
      owner_resource: "product",
      namespace: "dtp",
      key: "material",
      type: "single_line_text_field",
      value: material
    }
  });
  console.log(`   ✔ Metafield (dtp.material) = ${material}`);
}

// ───────── webhook ─────────
app.post("/webhook/products/create", async (req, res) => {
  try {
    const p = req.body;
    console.log("➡️  New product:", p.title);

    // If clearly not jewelry, bail to avoid junk content
    if (ELECTRONICS_WORDS.test(p.title || "")) {
      console.warn("   • Skipping enrichment (non-jewelry title detected).");
      return res.sendStatus(200);
    }

    const rawDesc = (p.body_html || "").toString();
    const desc = clamp(rawDesc.replace(/<[^>]+>/g, " "), 1200);
    const title = p.title || "";
    const combined = `${title} ${p.product_type || ""} ${(p.tags || "")} ${desc}`;

    // Infer attributes
    const material = inferMaterial(combined);
    const stone = inferStone(combined);
    const type = inferType({ title, product_type: p.product_type, tagsText: p.tags });
    const tags = uniq([...(p.tags || "").split(",").map(t => t.trim()).filter(Boolean), ...inferTags(combined)]);
    console.log("   • material:", material, "| stone:", stone || "-", "| type:", type, "| tags:", tags.join(", "));

    // Competitor pricing (optional)
    let benchPrice = null;
    if (SERPAPI_KEY && JEWELRY_WORDS.test(combined)) {
      const prices = await fetchCompetitorPrices(title);
      benchPrice = pickPriceFromCompetitors(prices);
      if (benchPrice) console.log("   • competitor picked:", benchPrice);
    }

    // Unique SEO
    const { title: seoTitle, description: seoDesc } = seoFrom({ title, description: desc, material, type, stone });
    await updateProductSEO(p.admin_graphql_api_id, seoTitle, seoDesc);

    // Generate & write on-page description HTML (if empty or very short)
    const productIdNum = Number(toNumericId(p.admin_graphql_api_id));
    if (!rawDesc || rawDesc.replace(/<[^>]+>/g, "").trim().length < 40) {
      // derive length options from variants for details block
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const mmOptions = uniq(
        variants
          .map(v => parseLengthMM(v.title) || parseLengthMM(v.option1) || parseLengthMM(v.option2) || parseLengthMM(v.option3))
          .filter(Boolean)
      );
      const html = buildProductHTML({ title, type, material, stone, lengthOptionsMM: mmOptions });
      await rest(`products/${productIdNum}.json`, "PUT", { product: { id: productIdNum, body_html: html } });
      console.log("   ✔ On-page description written");
    } else {
      console.log("   • Kept existing description (non-empty)");
    }

    // Tags via REST
    await rest(`products/${productIdNum}.json`, "PUT", { product: { id: productIdNum, tags: tags.join(", ") } });
    console.log(`   ✔ Tags set (${tags.length})`);

    // Variant pricing
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const isMoissanite = material === "s925+moissanite";
    for (const v of variants) {
      if (!v?.admin_graphql_api_id) continue;
      const mm = parseLengthMM(v.title) || parseLengthMM(v.option1) || parseLengthMM(v.option2) || parseLengthMM(v.option3);
      let price;
      if (isMoissanite && mm)      price = ladderPriceForMoissanite(mm);
      else if (benchPrice)         price = benchPrice;
      else                         price = fallbackPrice(material);
      await updateVariantPrice(v.admin_graphql_api_id, price);
    }

    // Metafield + collections + ALT text
    await setMaterialMetafield(p.admin_graphql_api_id, material);
    await addToCollectionIfExists(p.admin_graphql_api_id, "Necklaces");
    if (material === "s925+moissanite") await addToCollectionIfExists(p.admin_graphql_api_id, "Moissanite Jewelry");
    await setAltTextIfMissing(p.admin_graphql_api_id, `${seoTitle} by DTP Jewelry`);

    console.log(`✅ Finished "${title}"`);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

// Health
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on ${PORT}`));
