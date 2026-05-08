const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');

const turndownService = new TurndownService();
const BASE_URL = 'https://workproshop.com';
const DATA_DIR = __dirname;
const DETAILS_DIR = path.join(DATA_DIR, 'product_details');

if (!fs.existsSync(DETAILS_DIR)) {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchHtml(url) {
    try {
        console.log(`Fetching: ${url}`);
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        await delay(500); // 0.5s delay to be nice to the server
        return cheerio.load(data);
    } catch (e) {
        console.error(`Error fetching ${url}:`, e.message);
        return null;
    }
}

async function getCategories() {
    const $ = await fetchHtml(BASE_URL);
    if (!$) return [];
    
    const categories = [];
    $('a[href*="/product/list.html?cate_no="]').each((i, el) => {
        const href = $(el).attr('href');
        const name = $(el).text().trim().replace(/[\r\n\t]+/g, ' ');
        const cateNoMatch = href.match(/cate_no=(\d+)/);
        
        // Filter out empty names or non-specific categories if necessary
        if (cateNoMatch && name && !categories.find(c => c.id === cateNoMatch[1])) {
             categories.push({
                 id: cateNoMatch[1],
                 name: name,
                 url: href.startsWith('http') ? href : BASE_URL + href
             });
        }
    });
    
    fs.writeFileSync(path.join(DATA_DIR, 'structure.json'), JSON.stringify(categories, null, 2));
    console.log(`Found ${categories.length} categories.`);
    return categories;
}

async function getProductList(categoryUrl) {
    let products = [];
    let page = 1;
    let hasNext = true;
    
    while(hasNext) {
        const url = `${categoryUrl}&page=${page}`;
        const $ = await fetchHtml(url);
        if (!$) break;
        
        // typical cafe24 class names
        const items = $('.prdList > li, .xans-product-listmain > li, .xans-product-listnormal > li');
        if (items.length === 0) {
            hasNext = false;
            break;
        }
        
        items.each((i, el) => {
            const a = $(el).find('a').first();
            const href = a.attr('href');
            if(!href) return;
            
            const prodUrl = href.startsWith('http') ? href : BASE_URL + href;
            let name = $(el).find('.name, .prdName').text().trim();
            if (!name) name = a.text().trim();
            name = name.replace(/[\r\n\t]+/g, ' ');
            
            let price = $(el).find('.price, .xans-record- .title:contains("소비자가") + span, .xans-record- .title:contains("판매가") + span').text().trim();
            price = price.replace(/[\r\n\t]+/g, ' ');
            
            const productNoMatch = href.match(/product\/[^\/]+\/(\d+)/) || href.match(/product_no=(\d+)/);
            const id = productNoMatch ? productNoMatch[1] : `unknown_${Date.now()}_${i}`;
            
            if(!products.find(p => p.id === id)) {
                products.push({ id, name, price, url: prodUrl });
            }
        });
        
        const nextBtn = $('.xans-product-normalpaging a.next, .xans-product-paging a.next');
        if (nextBtn.length === 0 || nextBtn.attr('href') === '#none' || nextBtn.attr('href').endsWith(`page=${page}`)) {
             hasNext = false;
        } else {
             page++;
        }
    }
    return products;
}

async function getProductDetails(product) {
    const $ = await fetchHtml(product.url);
    if (!$) return;
    
    const name = $('.headingArea h2, .detailArea .name, .xans-product-detaildesign .name').text().trim().replace(/[\r\n\t]+/g, ' ');
    const priceStr = $('.infoArea .price, .infoArea .sale_price, .xans-product-detaildesign .price').text().trim().replace(/[\r\n\t]+/g, ' ');
    
    const detailHtml = $('.cont, #prdDetail, .xans-product-detail').html() || '';
    let markdown = '';
    try {
        markdown = turndownService.turndown(detailHtml);
    } catch(e) {
        console.error(`Turndown error for ${product.id}:`, e.message);
        markdown = detailHtml; // fallback
    }
    
    const productData = {
        id: product.id,
        name: name || product.name,
        price: priceStr || product.price,
        url: product.url,
        description_md: markdown,
        crawled_at: new Date().toISOString()
    };
    
    // Save JSON
    const filePath = path.join(DETAILS_DIR, `${product.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(productData, null, 2));
    
    // Save Markdown for AI Training
    const mdFilePath = path.join(DETAILS_DIR, `${product.id}.md`);
    fs.writeFileSync(mdFilePath, `# ${productData.name}\n\n**Product ID:** ${productData.id}\n**Price:** ${productData.price}\n**URL:** ${productData.url}\n\n## 상세 설명 (Description)\n\n${markdown}`);
}

async function main() {
    console.log("Starting crawler...");
    const categories = await getCategories();
    
    let allProducts = [];
    for (const cat of categories) {
        console.log(`Crawling category: ${cat.name} (ID: ${cat.id})`);
        const products = await getProductList(cat.url);
        console.log(`Found ${products.length} products in ${cat.name}`);
        allProducts = allProducts.concat(products);
    }
    
    const uniqueProductsMap = new Map();
    allProducts.forEach(p => uniqueProductsMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueProductsMap.values());
    
    fs.writeFileSync(path.join(DATA_DIR, 'product_lists.json'), JSON.stringify(uniqueProducts, null, 2));
    console.log(`Saved ${uniqueProducts.length} unique products to product_lists.json`);
    
    for (const prod of uniqueProducts) {
        console.log(`Crawling product details for: ${prod.id}`);
        await getProductDetails(prod);
    }
    
    console.log("Crawling finished successfully!");
}

main();
