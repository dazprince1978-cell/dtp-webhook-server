// server.js — FIXED: use productVariantUpdate for prices
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const SHOP = process.env.SHOPIFY_SHOP;         // dtpjewellry.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN;       // shpat_...
const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// helpers
const clamp = (s, n) => (s||"").toString().trim().replace(/\s+/g," ").slice(0, n);
const round99 = n => (Math.max(0, Math.round(n)) + 0.99).toFixed(2);

function seoFrom(title, description){
  const cleanTitle = clamp((title||"").replace(/\s+\|\s+.*/,""), 60);
  const metaDesc = clamp(description || "Luxury jewelry by DTP Jewelry.", 160);
  return { title: cleanTitle, description: metaDesc };
}

async function gql(query, variables={}){
  const res = await fetch(API, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// competitor pricing (optional)
async function fetchCompetitorPrices(query){
  if (!SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=en&gl=uk&api_key=${SERPAPI_KEY}`;
  const r = await fetch(url); 
  const j = await r.json();
  const out = [];
  for (const it of j.shopping_results||[]){
    const p = it.extracted_price;
    if (p) out.push(p);
  }
  return out.filter(x=>x>2 && x<2000);
}
function pickPrice(competitors){
  if (!competitors.length) return 29.99;
  const s = [...competitors].sort((a,b)=>a-b);
  const med = s[Math.floor(s.length/2)];
  return parseFloat(round99(med * 1.1)); // median +10%, .99
}

// mutations
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

app.post("/webhook/products/create", async (req,res)=>{
  try{
    const p = req.body;
    console.log("➡️ New product created:", p.title);

    // descriptions can be empty or HTML; strip tags safely
    const rawDesc = (p.body_html || "").toString();
    const desc = clamp(rawDesc.replace(/<[^>]+>/g," "), 1000);

    // competitor lookup -> price
    const competitors = await fetchCompetitorPrices(p.title || "");
    const newPrice = pickPrice(competitors);

    // 1) update SEO on the product
    const seo = seoFrom(p.title || "", desc);
    await gql(M_PRODUCT_UPDATE, { input: { id: p.admin_graphql_api_id, seo } });

    // 2) update price on each variant
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants){
      if (!v?.admin_graphql_api_id) continue;
      await gql(M_VARIANT_UPDATE, { input: { id: v.admin_graphql_api_id, price: newPrice } });
    }

    console.log(`✅ Updated "${p.title}" with SEO + price £${newPrice}`);
    res.sendStatus(200);
  }catch(e){
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Webhook server running on ${PORT}`));
