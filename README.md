# Prospect Ledger

Prospect rankings plus a daily minor league transaction wire. Stats and transactions come from MLB's public Stats API and refresh automatically. You only edit one file: `rankings.csv`.

## How it works

- `rankings.csv` holds your rankings, grades and write-ups.
- `scripts/update.mjs` reads your rankings, looks up each player on MLB's Stats API, pulls his stats by level and recent transactions, and writes `site/data/site.json`.
- The updater also pulls every player who appeared at an affiliated minor league level this season (several thousand) into `site/data/players.json`, using a handful of bulk calls per level.
- `site/index.html` is the website. It shows the Top 100, a searchable and sortable **Players** directory of every minor leaguer, the Transaction Wire, and a page for each player. Ranked prospects get full career stats; everyone else gets the current season by level.
- `.github/workflows/update.yml` runs the updater on a schedule (daily in the offseason, every 30 minutes April through September) and publishes the site to GitHub Pages. It also runs whenever you change a file.

## One-time setup (about 10 minutes)

1. Create a free account at github.com.
2. Create a new **public** repository (public repos get free GitHub Actions minutes and free Pages hosting).
3. Upload everything in this folder to the repository, keeping the folder structure. On the repo page, use **Add file → Upload files** and drag the folder contents in. The `.github` folder must be included; it's hidden on some computers, so check that it uploaded.
4. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
5. Go to the **Actions** tab, open **Update data and publish site**, and click **Run workflow**.
6. When it finishes (a minute or two), the site address appears in the run summary and under **Settings → Pages**. It looks like `https://YOUR-NAME.github.io/REPO-NAME/`.

## Updating your rankings

Open `rankings.csv` on GitHub, click the pencil icon, edit, and **Commit changes**. The site rebuilds automatically within a couple of minutes.

- `rank` and `name` are required. Use the player's full name as MLB.com lists it.
- If the update log warns that a name matched more than one player, add the `mlb_id` column: the number at the end of the player's MLB.com URL.
- `fv` (20-80 Future Value), `eta` and `blurb` are optional.
- Every time the list changes, the site saves a snapshot, and the Top 100 shows each player's movement since the previous version.

## Checking that it's running

The **Actions** tab lists every run. A green check means the data updated. A red X means something failed; click it to see the log. If a run fails, the site keeps showing the last good data.

## Changing the site name

Search for `Prospect Ledger` in `site/index.html` and replace it (three places: the `<title>`, the `SITE_NAME` line, and the header).

## Data use

MLB's Stats API is free but intended for individual, non-commercial use. Before charging for the site or running ads at scale, look into a licensed stats source. Never copy rankings or write-ups from other publications; the rankings and blurbs here should be your own.

## Subscriber gate (paywall)

`site/index.html` has a passcode gate. Without the passcode, visitors see the top 10 of the rankings and the "How the rankings work" page; everything else shows a "Subscribers only" screen. Entering the passcode unlocks that browser until someone clicks "Lock this device" in the footer.

Settings near the top of the script in `site/index.html`:
- `PASS_HASH`: the SHA-256 hash of the passcode (the passcode itself isn't stored in the file). To change the passcode, hash the new one (for example at any SHA-256 tool) and paste the result here.
- `SUBSCRIBE_URL`: paste a payment link (for example a Stripe Payment Link) to show a Subscribe button.
- `FREE_RANKS`: how many ranked players are free to view.

Limits: GitHub Pages only serves static files, so this gate runs in the visitor's browser. It stops casual visitors, but the data files (`site/data/*.json`) and this repository are public, and anyone technical can read them. A real paywall needs a host that checks a login before serving data, such as Netlify or Vercel with a membership service, or Cloudflare Access. Also check MLB's data terms before charging: the free Stats API is meant for non-commercial use.
