// server.js
// Minimal Shopify webhook server with SEO + auto-pricing
// Run with: node server.js

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

// --- Config from environment variables ---
const SHOP = process.env.SHOPIFY_SHOP;         // e.g. "dtpjewellry.myshopify.com"
const TOKEN = process.env.SHOPIFY_TOKEN;       // Shopify Admin API token
const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const USD_GBP = parseFloat(process.env.USD_GBP || "0.78");

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// --- Helpers ---
const clamp = (s, n) => (s||"").trim().replace(/\s+/g," ").slice(0, n);
const round99 = n => (Math.max(0, Math.round(n)) + 0.99).toFixed(2);

function seoFrom(title, description){
  const cleanTitle = clamp(title.replace(/\s+\|\s+.*/,""), 60);
  const metaDesc = clamp(description || "Luxury jewelry by DTP Jewelry.", 160);
  return { title: cleanTitle, description: metaDesc };
}

async function gql(query, variables={}){
  const res = await fetch(API, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// --- Competitor price lookup (SerpAPI) ---
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
  const sorted = competitors.sort((a,b)=>a-b);
  const med = sorted[Math.floor(sorted.length/2)];
  return round99(med * 1.1); // median +10% premium
}

// --- Webhook endpoint for new products ---
app.post("/webhook/products/create", async (req,res)=>{
  try{
    const product = req.body;
    console.log("➡️ New product created:", product.title);

    const { title, body_html } = product;
    const desc = body_html.replace(/<[^>]+>/g,"");

    // competitor lookup
    const competitors = await fetchCompetitorPrices(title);
    const price = pickPrice(competitors);

    // SEO
    const seo = seoFrom(title, desc);

    // Update product in Shopify
    const mutation = `
      mutation($input:ProductInput!){
        productUpdate(input:$input){
          product{ id title }
          userErrors{ field message }
        }
      }`;
    const input = {
      id: product.admin_graphql_api_id,
      seo,
      variants: [{ id: product.variants[0].admin_graphql_api_id, price }]
    };
    await gql(mutation, { input });

    console.log(`✅ Updated ${title} with SEO + price £${price}`);
    res.sendStatus(200);
  }catch(e){
    console.error("❌ Webhook error:", e);
    res.sendStatus(500);
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Webhook server running on port ${PORT}`));
