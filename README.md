# AOL Programs

One web app with several tools, each in its own tab. The home page lets you choose one.

| Tab | Path | What it does |
| --- | --- | --- |
| People | `/care/` | Everyone in your circle and their journey; Today's follow-up queue; WhatsApp / SMS / Call; events with sign-up and check-in QR codes. Needs a staff token |
| Outreach Finder | `/outreach/` | Find events, universities, wellness clubs and contacts in a Canadian city; manage leads; export CSV |
| Flyer Studio | `/flyer/` | Survey → checked, print-ready course flyer with a real QR code; human review before download |
| Follow-up Survey | `/survey/` | Public phone survey for program graduates with a suggested next step |
| SevaAssist | `/ask/` | Approved answers for volunteers and teachers, with sources. Needs a staff token |
| Staff Dashboard | `/staff/` | Trends, suggestions and named responses. Needs the staff token |

Public pages opened from event QR codes (no login): `/e/<event>` to register, `/e/<event>/in` to check in at the venue.

In Flyer Studio, choose a course or event type from the People program list, or choose Other. **Add to events** copies that type and the current form's title, first date and start time, location and description into a People event draft. Sign in, review the program and details, and create the event to save it; the flyer image and later dates are not copied.

## People & Journeys

- **Today:** people to reconnect with, most urgent first: overdue promised check-ins, check-ins due today, new people who just signed up, and people coming to an event in the next 7 days. People without consent or marked "do not contact" never appear.
- **I'll contact them** claims a person for 24 hours so two volunteers don't contact the same person.
- **Call / WhatsApp / SMS** open the volunteer's own phone apps with an editable message already written. Nothing is sent automatically; the volunteer presses send. Then log the outcome (Interested, Not now, No answer, Messaged), a note and the next check-in date.
- **Journey:** Intro Talk → Part 1 → Sahaj → Part 2 → Sanyam 1 → Sanyam 2, plus VTP, TTC, Yoga TTC and Guru Pooja Part 1 and 2. Each completed step keeps its date and teacher; the next suggested step is highlighted.
- **Events:** each event gets a permanent link and two QR codes (Register, Check-in) to download as PNG or SVG, copy, or share on WhatsApp. Sign-ups are matched to existing people by phone number. Checking in at an Intro Talk adds that step automatically; for other programs press **Mark completed** to add the step (with the event's teacher) to everyone who attended.
- **Roles:** the manager token can do everything, including deleting people and events and editing SevaAssist answers. The volunteer token can do everything else.

SevaAssist starts with the 4 fictional example answers from the prototype. Replace them with approved answers (manager sign-in) before real use. Like the original, it only answers when a question closely matches an approved one, and a volunteer question never matches a teacher answer (or the other way round).

## Run it

Needs **Node.js 24** (the survey uses the built-in `node:sqlite`). No `npm install`; there are no dependencies.

```bash
cd aol-programs
npm start          # http://127.0.0.1:3000
npm test           # survey (24), people & SevaAssist (10) and flyer engine checks
```

Settings live in `.env` (copy `.env.example` to start). `.env` holds secrets, so keep it out of git (it is in `.gitignore`).

- `AOL_CARE_DEMO=1`: enables one-click Manager and Volunteer sign-in in People, including named demo volunteers Rohit, Nitin and Laxmikant. These are shared-role demo identities, not individual accounts. People, events and SevaAssist use a separate in-memory database that is lost on restart; real staff tokens and People data are not used in this mode. Demo mode requires a loopback `HOST` and is not for deployment. The survey and staff dashboard are not isolated by this setting.
- `AOL_MANAGER_TOKEN`: sign in to the Staff Dashboard with this. It sees everything, including names and comments.
- `AOL_REPORT_TOKEN`: optional. Sees totals and charts only. Blank disables that role.
- `AOL_VOLUNTEER_TOKEN`: give this to volunteers and teachers for People and SevaAssist (no deleting).
- `AOL_TIME_ZONE`: decides what "today" is in the follow-up queue (default `America/Edmonton`).
- `AOL_PHONE_COUNTRY_CODE`: added to 10-digit phone numbers for WhatsApp/SMS links (default `1`, Canada/US).
- `AOL_CARE_DB_PATH`: where people, journeys and events are stored (default `data/care.sqlite`).
- `HOST` / `PORT`: where the app listens. Use `HOST=0.0.0.0` when hosting or testing from a phone on the same Wi-Fi.
- `AOL_PUBLIC_ORIGIN`: set this to the site's exact origin in production (e.g. `https://programs.example.org`, no trailing slash).
- `AOL_FOLLOWUPS_URL`, `AOL_VOLUNTEER_URL`, `AOL_TEACHER_URL`, `AOL_ONLINE_URL`: optional approved HTTPS links for survey results.
- `ADMIN_TOKEN`: Flyer Studio operator panel when hosted. Blank means the operator panel only works from this computer.
- `ANTHROPIC_API_KEY`: optional AI-written invitation line in Flyer Studio.
- `TICKETMASTER_KEY`: optional live events in Outreach Finder.

Generate a new token with:

```bash
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

## Layout

```
server.mjs            one server; routes /outreach, /flyer, /survey, /staff to each app in-process
public/               home page and tab bar
apps/outreach/        Outreach Finder
apps/flyer/           Flyer Studio
apps/survey/backend   survey API + SQLite storage (data/aol-programs.sqlite)
apps/survey/frontend  public survey page
apps/survey/dashboard staff dashboard page
apps/care/            People & Journeys, public event pages and SevaAssist (data/care.sqlite)
```

## Notes

- Staff API routes are only reachable under `/staff/api/...` with a token. They return 404 under `/survey/`.
- The staff dashboard now shares the public site's address. It stays protected by the token, but consider putting `/staff/` behind your organisation's sign-in if the site is public.
- Outreach Finder: put your own contact email in `UA` at the top of `apps/outreach/server.js` before deploying (OpenStreetMap asks for one).
- Free hosting (Render): `render.yaml` is included. Free instances have no persistent disk, so people, leads, flyers and survey responses are wiped on restart unless you attach a disk and point `AOL_DB_PATH` at it.
