import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

if (!SHOP || !TOKEN) {
  console.error("❌ Missing SHOPIFY_SHOP or SHOPIFY_TOKEN env vars.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// ---------- helpers ----------
const clamp = (s, n) => (s || "").toString().trim().replace(/\s+/g, " ").slice(0, n);
const round99 = (n) => (Math.max(0, Math.round(n)) + 0.99).toFixed(2);
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
const toNumericId = (gid) => (gid ? String(gid).split("/").pop() : null);

function seoFrom(title, description) {
  const cleanTitle = clamp(title || "Luxury Jewelry by DTP Jewelry", 60);
  const metaDesc = clamp(description || "Luxury jewelry handcrafted by DTP Jewelry.", 160);
  return { title: cleanTitle, description: metaDesc };
}

function inferMaterial(text) {
  const s = (text || "").toLowerCase();
  if (/\bmoissanite\b/.test(s) && (/\bs925\b/.test(s) || /sterling/.test(s))) return "s925+moissanite";
  if (/\bs925\b/.test(s) || /sterling silver/.test(s)) return "s925+plain";
  if (/stainless/.test(s)) return "steel+plain";
  if (/crystal|quartz|agate|stone|amethyst|opal|carnelian|tiger'?s eye/.test(s)) return "alloy+stone";
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
  return Array.from(tags);
}

function ladderPriceForMoissanite(mm) {
  if (!mm) return 329.99;
  if (mm <= 460) return 329.99;
  if (mm <= 510) return 349.99;
  return 369.99;
}

function fallbackPrice(material) {
  if (material === "s925+moissanite") return 329.99;
  if (material === "s925+plain") return 24.99;
  if (material === "steel+plain") return 14.99;
  return 21.99;
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
  return parseFloat(round99(med * 1.1));
}

// ---------- REST + GraphQL helpers ----------
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
  if (j.errors || j.data?.productUpdate?.userErrors?.length) {
    console.error("❌ SEO update failed:", JSON.stringify(j));
  } else {
    console.log("   ✔ SEO updated:", title);
  }
}

async function updateVariantPriceREST(variantGid, price) {
  const id = Number(toNumericId(variantGid));
  await rest(`variants/${id}.json`, "PUT", { variant: { id, price: String(price) } });
  console.log(`   ✔ Variant ${id} -> £${price}`);
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

// ---------- webhook ----------
app.post("/webhook/products/create", async (req, res) => {
  try {
    const p = req.body;
    console.log("➡️ New product:", p.title);

    const rawDesc = (p.body_html || "").toString();
    const desc = clamp(rawDesc.replace(/<[^>]+>/g, " "), 1000);
    const title = p.title || "";
    const combinedText = `${title} ${desc}`;

    const material = inferMaterial(combinedText);
    const tags = uniq([...(p.tags || "").split(",").map(t => t.trim()).filter(Boolean), ...inferTags(combinedText)]);

    let benchPrice = null;
    if (SERPAPI_KEY) {
      const prices = await fetchCompetitorPrices(title);
      benchPrice = pickPriceFromCompetitors(prices);
    }

    const { title: seoTitle, description: seoDescription } = seoFrom(title, desc);

    // Run updates
    await updateProductSEO(p.admin_graphql_api_id, seoTitle, seoDescription);

    const productIdNum = Number(toNumericId(p.admin_graphql_api_id));
    await rest(`products/${productIdNum}.json`, "PUT", { product: { id: productIdNum, tags: tags.join(", ") } });
    console.log(`   ✔ Tags set (${tags.length})`);

    const variants = Array.isArray(p.variants) ? p.variants : [];
    const isMoissanite = material === "s925+moissanite";
    for (const v of variants) {
      if (!v?.admin_graphql_api_id) continue;
      let price;
      if (isMoissanite) price = ladderPriceForMoissanite();
      else if (benchPrice) price = benchPrice;
      else price = fallbackPrice(material);
      await updateVariantPriceREST(v.admin_graphql_api_id, price);
    }

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

app.get("/", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on ${PORT}`));



