# Outreach Finder (Hackathon)

Pick a Canadian city + dates -> events, universities, wellness clubs, influencers and a contact person. Add them as leads, track status/follow-ups, send email drafts, export CSV.

**Live data (free, no API key):** universities/colleges and yoga/meditation/wellness places come from OpenStreetMap (Overpass API) for 17 Canadian cities. A "Find contact" button reads the place's public website for an email/phone. Events = recurring calendar moments (frosh week, World Mental Health Day, ...) plus live Ticketmaster events if you set `TICKETMASTER_KEY` (free key from developer.ticketmaster.com).

**Mock fallback:** if the live lookup fails, Toronto, Vancouver, Montreal and Moncton fall back to `data/cities.json` (fictional contacts marked "mock"). Before deploying, put your own email in `UA` at the top of `server.js` (OpenStreetMap asks for a contact in the User-Agent).

**Limits:** OpenStreetMap contact details are sparse (many places have no email), so expect a mix. Use scraped contacts for organization/role inboxes, and follow CASL (Canada anti-spam law) before bulk emailing.

## Run locally
1. Install Node 18+ from https://nodejs.org
2. Open a terminal in this folder and run: `node server.js`
3. Visit http://localhost:3000   (no `npm install` needed, zero dependencies)

## Host for free (Render)
1. Push this folder to a GitHub repo.
2. On https://render.com: New > Web Service > connect the repo. It reads `render.yaml` (Node, free plan, start `node server.js`).
3. Free tier caveats: sleeps after inactivity (first load ~30s) and the disk is wiped on restart, so leads reset. For a demo this is fine; for persistence swap `readLeads/writeLeads` in `server.js` for a free Supabase or MongoDB Atlas database.

## Structure
- `server.js` REST API + static server (`/api/cities`, `/api/outreach`, `/api/leads`, `/api/leads/:id`, `/api/leads/:id/message`, `/api/contact?url=`, `/api/leads.csv`)
- `public/index.html` the frontend
- `data/cities.json` mock data; add cities by copying a block
- `livePlaces()`, `findContact()` and `ticketmaster()` in `server.js` are the data sources; add more (Playwright scrapers, Eventbrite) next to them
