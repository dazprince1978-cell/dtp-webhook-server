// DTP Auto SEO + Description (v6)
// Focused: only SEO & product description. No pricing/tags/collections.
// API: Shopify Admin 2024-07
// ENV required: SHOPIFY_SHOP, SHOPIFY_TOKEN

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;   // e.g. dtpjewellry.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN; // shpat_xxx
const API = `https://${SHOP}/admin/api/2024-07`;

if (!SHOP || !TOKEN) {
  console.error("❌ Missing SHOPIFY_SHOP or SHOPIFY_TOKEN");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// ───────── helpers
const clamp = (s, n) => (s || "").toString().trim().replace(/\s+/g, " ").slice(0, n);
const toNum = (gid) => String(gid || "").split("/").pop();

async function rest(path, method = "GET", body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return res.json();
}

async function gql(query, variables) {
  const r = await fetch(`${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  return j;
}

// remove any supplier images dropped into the description
function stripImages(html = "") {
  return (html || "")
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<img[\s\S]*?>/gi, "");
}

// lightweight inference
const STONE_RE = /(moissanite|amethyst|opal|agate|carnelian|rose quartz|quartz|tiger'?s eye|onyx|malachite|turquoise|zircon|cubic zirconia|cz|crystal|garnet|ruby|sapphire|emerald)/i;

function inferStone(text) {
  const m = (text || "").match(STONE_RE);
  if (!m) return null;
  const s = m[0].toLowerCase();
  if (s === "cz" || s === "cubic zirconia") return "Cubic Zirconia";
  if (s.includes("tiger")) return "Tiger’s Eye";
  if (s.includes("rose quartz")) return "Rose Quartz";
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function inferMaterial(text) {
  const s = (text || "").toLowerCase();
  if (/\bmoissanite\b/.test(s) && (/\b925\b/.test(s) || /sterling/.test(s))) return "S925 Sterling Silver with Moissanite";
  if (/\b925\b/.test(s) || /sterling silver/.test(s)) return "S925 Sterling Silver";
  if (/stainless/.test(s)) return "Stainless Steel";
  if (/gold/.test(s)) return "Gold-tone Alloy";
  return "Alloy with Polished Finish";
}

function inferType(text) {
  const s = (text || "").toLowerCase();
  if (s.includes("bracelet")) return "Bracelet";
  if (s.includes("earring")) return "Earrings";
  if (s.includes("ring")) return "Ring";
  if (s.includes("anklet")) return "Anklet";
  if (s.includes("choker")) return "Choker";
  if (s.includes("pendant") && s.includes("necklace")) return "Pendant Necklace";
  if (s.includes("chain") && s.includes("necklace")) return "Chain Necklace";
  if (s.includes("necklace")) return "Necklace";
  return "Jewelry";
}

function inferStyleKeywords(text) {
  const s = (text || "").toLowerCase();
  const out = [];
  if (s.includes("retro") || s.includes("vintage")) out.push("Retro/Vintage");
  if (s.includes("palace")) out.push("Palace");
  if (s.includes("european")) out.push("European");
  if (s.includes("italian")) out.push("Italian");
  if (s.includes("medallion") || s.includes("medal")) out.push("Medallion");
  if (s.includes("floral") || s.includes("flower")) out.push("Floral");
  if (s.includes("sun") || s.includes("sunburst")) out.push("Sunburst");
  if (s.includes("filigree")) out.push("Filigree");
  return out;
}

function parseDims(text) {
  const s = (text || "").toLowerCase();
  // pendant size e.g. 31*27.5mm or 31×27.5mm
  const m = s.match(/(\d+(?:\.\d+)?)\s*[x\*×]\s*(\d+(?:\.\d+)?)\s*mm/);
  const mm = s.match(/\b(4[0-9]{2}|5[0-9]{2})\s*mm\b/); // 400–599 mm chain
  const cm = s.match(/\b(4[0-9]|5[0-9])\s*cm\b/);       // 40–59 cm chain
  let chain = null;
  if (mm) chain = `${mm[1]}mm`;
  else if (cm) chain = `${cm[1]}cm`;
  const pendant = m ? `${m[1]} × ${m[2]} mm` : null;
  return { chain, pendant };
}

// SEO
function buildSEO({ title, material, type, stone, styles }) {
  const clean = title.replace(/\s+\|\s+.*/, "").trim();
  const stoneBit = stone ? `${stone} ` : "";
  const styleBit = styles.length ? `${styles[0]} ` : "";
  const seoTitle = clamp(`${clean} | ${styleBit}${stoneBit}${material} ${type} by DTP Jewelry`, 60);
  const hook =
    stone && /Moissanite/i.test(stone) ? "Brilliant sparkle that rivals diamonds."
    : styles.includes("Retro/Vintage") ? "Vintage-inspired detailing with modern durability."
    : "Elegant, durable and gift-ready.";
  const seoDesc = clamp(`${clean} — ${type} in ${stoneBit}${material}. ${hook}`, 160);
  return { seoTitle, seoDesc };
}

// Description
function buildDescription({ title, material, type, stone, styles, chain, pendant }) {
  const styleLead = styles.length ? `${styles.join(" • ")} ` : "";
  const stoneLine = stone ? `${stone} accents` : "a high-polish finish";
  const bullets = [
    stone && /Moissanite/i.test(stone) ? "Diamond-like brilliance with exceptional fire" : null,
    material.includes("S925") ? "Hypoallergenic and comfortable for daily wear" : "Comfortable for everyday wear",
    chain ? `Adjustable chain length: ${chain}` : null,
    "Versatile design—easy to dress up or down",
    "Arrives gift-ready"
  ].filter(Boolean);

  return `
<p><strong>${title}</strong></p>
<p>${styleLead}${type} crafted in ${material} with ${stoneLine}. A refined piece that elevates everyday style and shines for special occasions.</p>

<p><strong>Why you’ll love it</strong></p>
<ul>
  ${bullets.map(b => `<li>${b}</li>`).join("\n")}
</ul>

<p><strong>Details</strong></p>
<ul>
  <li>Material: ${material}</li>
  ${stone ? `<li>Stone: ${stone}</li>` : ""}
  ${pendant ? `<li>Pendant size: ${pendant}</li>` : ""}
  ${chain ? `<li>Chain length: ${chain}</li>` : ""}
  ${styles.length ? `<li>Style: ${styles.join(", ")}</li>` : ""}
</ul>

<p><strong>Care</strong></p>
<p>Wipe with a soft dry cloth after wear. Store separately to protect the finish and setting.</p>
`.trim();
}

// write SEO via GraphQL (productUpdate)
async function updateSEO(productGid, seoTitle, seoDesc) {
  const mutation = `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`;
  const j = await gql(mutation, { input: { id: productGid, seo: { title: seoTitle, description: seoDesc } } });
  const errs = j.errors || j.data?.productUpdate?.userErrors || [];
  if (errs.length) throw new Error("SEO update failed: " + JSON.stringify(errs));
}

// ───────── webhook
app.post("/webhook/products/create", async (req, res) => {
  const p = req.body;
  try {
    const title = p.title || "";
    const incomingHTML = (p.body_html || "").toString();
    const stripped = stripImages(incomingHTML);
    const flatText = stripped.replace(/<[^>]+>/g, " ");

    // only enrich jewelry-ish titles
    if (!/(necklace|bracelet|earring|ring|jewel)/i.test(title)) {
      console.log(`• Skipped non-jewelry: ${title}`);
      return res.sendStatus(200);
    }

    const material = inferMaterial(`${title} ${flatText}`);
    const type = inferType(`${title} ${flatText}`);
    const stone = inferStone(`${title} ${flatText}`);
    const styles = inferStyleKeywords(`${title} ${flatText}`);
    const dims = parseDims(`${title} ${flatText}`);

    // build SEO + description
    const { seoTitle, seoDesc } = buildSEO({ title, material, type, stone, styles });
    const html = buildDescription({
      title, material, type, stone,
      styles,
      chain: dims.chain,
      pendant: dims.pendant
    });

    // 1) SEO
    await updateSEO(p.admin_graphql_api_id, seoTitle, seoDesc);
    console.log("✔ SEO updated");

    // 2) Body HTML (always overwrite, images already stripped)
    await rest(`products/${p.id}.json`, "PUT", { product: { id: p.id, body_html: html } });
    console.log("✔ Description written (images removed & supplier text replaced)");

    console.log(`✅ Finished "${title}"`);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

app.get("/", (_, res) => res.send("DTP SEO server live"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on ${PORT}`));
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

