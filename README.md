# MiLB Report

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

Search for `MiLB Report` in `site/index.html` and replace it (three places: the `<title>`, the `SITE_NAME` line, and the header).

## Data use

MLB's Stats API is free but intended for individual, non-commercial use. Before charging for the site or running ads at scale, look into a licensed stats source. Never copy rankings or write-ups from other publications; the rankings and blurbs here should be your own.

## Subscriptions (paywall)

Without access, visitors see the top 10 of the rankings, those players' pages and the "How the rankings work" page. Everything else (ranks 11-100, the Players directory, the Transaction Wire, other player pages) shows a "Subscribers only" box.

Subscribers sign in with the small key button in the bottom-right corner of every page. Entering the passcode unlocks that browser until they choose "Lock this device" in the same panel.

Settings near the top of the script in `site/index.html`:
- `PASS_HASH`: the SHA-256 hash of the subscriber passcode (the passcode itself isn't stored in the file). To change the passcode, hash the new one with any SHA-256 tool and paste the result here.
- `SUBSCRIBE_URL`: your Stripe Payment Link. Until it's set, the box says "Subscriptions open soon."
- `SUB_PRICE`: the price to show, e.g. `$6 / month`.
- `FREE_RANKS`: how many ranked players are free.

### Taking payments with Stripe
1. Create a Stripe account and a recurring Product (for example monthly).
2. Create a Payment Link for it. Under "After payment," choose "Show confirmation page" and put the passcode in the custom message, e.g. "Your MiLB Report passcode is ____. Tap the key in the bottom-right corner of the site to sign in."
3. Paste the Payment Link into `SUBSCRIBE_URL` and set `SUB_PRICE`.
4. When you change the passcode, update that confirmation message too.

### Limits
GitHub Pages only serves static files, so this gate runs in the visitor's browser. Everyone shares one passcode, it can be passed around, and canceling a subscription doesn't remove access. The data files (`site/data/*.json`) and this repository are public, so anyone technical can read the content directly. A real paywall needs a host that checks each subscriber's login before serving data, such as Netlify or Vercel with a membership service connected to Stripe. Also check MLB's data terms before charging: the free Stats API is meant for non-commercial use.
