# Flyer Studio

Front end and host application for the **Art of Living Creative Engine v1.2** (the Flyer Studio system prompt).
Zero dependencies: Node 18+ only.

## Run it

```
cd flyer-studio
node server.js        # then open http://localhost:3000
npm test              # QR round trip and helper checks
```

It starts in **demo** profile so you can see the full flow straight away: press **Load sample answers**, then **Make my flyer**.
A demo flyer is labelled "DESIGN SAMPLE · FICTIONAL EVENT", uses example.org contacts only, and always ends as *Demo draft preview*. It is never marked ready.

## What it does

1. **Survey A to G** exactly as the engine specifies: purpose, feel, Gurudev photo, city photo, dates and times, contacts, QR code.
2. **Brief check.** Missing or doubtful facts come back as plain questions (NEEDS_INPUT). Nothing is invented. Notes typed in the form are recorded but cannot change rules.
3. **Gate A.** The browser measures the text and lays out the flyer; the server re-validates the layout (90 px safe margin, type sizes, no overlaps, copy matches the frozen text ledger, asset fit, QR size) and only then approves a render.
4. **Layered render.** Original logo and photos are drawn uncropped except for proportional crop; a genuine QR is drawn from real modules; text is typeset, never baked into an image.
5. **Checks on the exported PNG.** Dimensions, text ledger against the draw log, contrast measured on pixels, margin scan, QR decoded from the final image, asset fidelity.
6. **Human review and Gate B.** A reviewer ticks the items automatic checks cannot judge and scores eight dimensions. Release needs 4 or more on every one. **Download is blocked until the status is READY.**

When the brief needs changes, the relevant fields show the check's questions inline. Update the answers and select **Make my flyer** again to recheck them.

## Production setup (real flyers)

Open **Operator** in the top bar (allowed from this computer, or with `ADMIN_TOKEN` when hosted).
- Set the profile to **Production**.
- Upload the approved **logo** (and an approved **Gurudev portrait** if flyers will use one). Production refuses to render without a logo unless you set the logo policy to reserve space or omit.
- Optionally upload approved brand **fonts** (otherwise system fonts are used and the checks say so).
You can also copy files into `assets/logos`, `assets/gurudev`, `assets/brand/fonts`.

## Optional: AI-written invitation line

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) before starting. The engine prompt in `engine/system-prompt.txt` is used as the system prompt for one short line; the host validates the result against its rules and falls back to a template line if it fails. Without a key everything still works.

## Free hosting (Render)

1. Push this folder to a GitHub repository.
2. On render.com choose **New > Blueprint**, select the repo; `render.yaml` sets everything up.
3. Copy the generated `ADMIN_TOKEN` from the service's environment tab. The Operator panel asks for it.
4. Free instances sleep when idle and have no persistent disk: uploaded assets, past flyers and settings are wiped on restart. Put real assets in the repo under `assets/` if you need them to survive, and download flyers when done.

## Honest limits

- No OCR: text correctness is proven by the frozen ledger and draw log, not by reading the picture back.
- Layout and look need a person: that is what the review step is for.
- Fonts are system fonts unless you upload approved ones.
- Not tested here with the real Art of Living logo or portraits (none were supplied); the pipeline was exercised with neutral placeholders.
- Live link checking is best effort unless the operator sets it to required.
