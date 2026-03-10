# Create Revenue — Website + Email-to-Publish

B2B sales coaching website for Brendan McAdams. Built with Astro, deployed on Cloudflare Pages, with an email-to-publish workflow powered by Cloudflare Email Workers and Claude API.

## Stack

- **Astro** — Static site generator with content collections
- **Cloudflare Pages** — Hosting, auto-deploy from GitHub
- **Cloudflare Email Workers** — Email-to-publish workflow
- **Claude API (Haiku)** — Email → Markdown conversion
- **Pagefind** — Client-side search (zero-cost, runs at build)
- **GitHub API** — Programmatic commits for the publish flow

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production (includes Pagefind indexing)
npm run build

# Preview production build
npm run preview
```

## Project Structure

```
createrevenue-site/
├── public/
│   ├── robots.txt
│   ├── favicon.svg
│   └── images/
├── src/
│   ├── content/
│   │   ├── config.ts          # Blog collection schema
│   │   └── blog/              # Markdown blog posts
│   ├── components/
│   │   ├── SEOHead.astro      # Meta tags, OG, structured data
│   │   ├── Header.astro       # Nav with mobile menu
│   │   ├── Footer.astro
│   │   └── BlogCard.astro     # Blog index card
│   ├── layouts/
│   │   ├── BaseLayout.astro   # Wraps all pages
│   │   └── BlogPost.astro     # Blog post layout with article markup
│   ├── pages/
│   │   ├── index.astro        # Home
│   │   ├── about.astro
│   │   ├── services.astro
│   │   ├── contact.astro
│   │   ├── blog/
│   │   │   ├── index.astro    # Blog listing + Pagefind search
│   │   │   └── [slug].astro   # Dynamic blog post pages
│   │   └── rss.xml.js         # RSS feed
│   └── styles/
│       └── global.css         # Design system + base styles
├── workers/
│   └── email-publish.js       # Cloudflare Email Worker
├── astro.config.mjs
├── wrangler.toml              # Worker config
└── package.json
```

## Deployment

### Site (Cloudflare Pages)

1. Push repo to GitHub
2. In Cloudflare dashboard: Pages → Create project → Connect GitHub repo
3. Build settings:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node version:** 18+
4. Add custom domain: `createrevenue.com`

### Email Worker

1. Set secrets:
   ```bash
   wrangler secret put GITHUB_TOKEN
   wrangler secret put CLAUDE_API_KEY
   wrangler secret put POSTMARK_TOKEN  # optional
   ```
2. Deploy worker:
   ```bash
   wrangler deploy
   ```
3. In Cloudflare dashboard → Email Routing:
   - Route `publish@createrevenue.com` → Email Worker
   - Route `approve+*@createrevenue.com` → Email Worker

## Email-to-Publish Flow

1. **Write:** Email `publish@createrevenue.com` — subject = title, body = content
2. **Preview:** Receive email with staging preview URL
3. **Publish:** Reply "OK" to go live, or reply with corrections to revise
4. **Live:** Post appears at `createrevenue.com/blog/{slug}/`

## SEO

Built in from day one:
- Semantic HTML with proper heading hierarchy
- Unique `<title>` and meta description per page
- Open Graph + Twitter Card meta tags
- JSON-LD structured data (Organization + BlogPosting)
- Canonical URLs
- Auto-generated sitemap.xml
- robots.txt
- RSS feed
- Clean URL structure (`/blog/post-slug/`)

## Adding Blog Posts Manually

Create a `.md` file in `src/content/blog/`:

```markdown
---
title: "Your Post Title"
description: "A brief description under 160 characters."
pubDate: 2026-03-15
tags: ["sales", "health tech"]
---

Your content here in Markdown.
```

## Cost

| Component | Cost |
|---|---|
| Cloudflare Pages | Free |
| Cloudflare Email Workers | Free |
| Cloudflare Email Routing | Free |
| Claude API (Haiku) | ~$0.01/publish |
| Pagefind | Free (runs at build) |
| **Total** | **~$0/month** (unless high publish volume) |
