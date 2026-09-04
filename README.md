# GeoKosova

GeoGuessr vetëm me territorin e Kosovës. Hidhesh në një pikë të rastit brenda kufirit
dhe duhet t'ia qëllosh vendin në hartë — sa më afër, aq më shumë pikë.

Tri variante:

| Faqja | Çka është | Çka duhet |
|---|---|---|
| `/` | Një lojtar, Google Street View | Google Maps API key |
| `/multiplayer.html` | Deri 12 lojtarë, dhomë e përbashkët | Google Maps API key |
| `/mapillary.html` | Një lojtar, imazhe Mapillary | Mapillary token (falas, pa kartë) |

Vetëm Kosova: kufiri është poligon me 322 pika nga OpenStreetMap, dhe panoramat që bien
jashtë tij hidhen tej gjatë zgjedhjes. Në modin "Lehtë", ecja bllokohet në kufi.

## Nisja

```
node server.js
```

Serveri hapet në `http://localhost:8765`. **Zero varësi npm** — vetëm `http` dhe `fs`
të Node-it. Transporti i multiplayer-it është SSE, pa WebSocket.

## Struktura

```
server.js              server statik + multiplayer (dhoma, koha, pikëzimi)
config.example.json    shablloni; kopjoje si config.json dhe fute kyçin
public/
  index.html           një lojtar, Street View
  multiplayer.html     klienti multiplayer
  mapillary.html       një lojtar, Mapillary + OpenStreetMap
```

`config.json` mban kyçin, është në `.gitignore`, dhe serveri nuk e shërben si skedar.
Klientët jetojnë nën `public/`, pra `server.js` dhe `config.json` bien jashtë dosjes së
shërbyer dhe nuk arrihen dot nga rrjeti.

## Kyçi i Google — konfigurimi për multiplayer

Pa konfigurim, **çdo lojtar** duhet ta fusë kyçin e vet. Për t'ia shmangur kjo shokëve,
hosti e vendos kyçin një herë:

```
cp config.example.json config.json      # pastaj fute kyçin brenda
```

ose me variabël mjedisi:

```
GMAPS_KEY=AIza... node server.js
```

Kyçi u shërbehet lojtarëve që lidhen me këtë server, përmes `/api/config`.

**Kjo do të thotë tri gjëra që duhen ditur:**

1. Kushdo që hap faqen tënde e merr kyçin. Kufizoje në Google Cloud Console te
   *Application restrictions → Websites*, me origjinën e serverit tënd.
2. Kuota e Street View shpenzohet nga **të gjithë** lojtarët — 5 000 panorama falas/muaj,
   pra një raund për lojtar për raund. Një lojë 5-raundesh me 4 shokë = 20 panorama.
3. `config.json` nuk shërbehet nga serveri dhe nuk duhet futur në git.

## Si funksionon multiplayer-i

- Hosti krijon dhomë → kod me 4 shenja → ndan linkun `?room=KODI`.
- **Serveri** mban fazën, kohën dhe pikët. Klienti nuk i llogarit pikët e vet.
- Vendet i zgjedh shfletuesi i hostit, sepse `StreetViewService` punon vetëm në klient.
  Hosti i dërgon në server, serveri i shpërndan te të gjithë.
- Gjatë raundit klientët marrin **vetëm `panoId` dhe `heading`** — koordinatat e
  përgjigjes dërgohen pas mbarimit të raundit, pra nuk lexohen nga Network tab.
- Të gjithë nisin me të njëjtin `heading`, pra pamja e fillimit është e barabartë.
- Koha për raund caktohet 10, 20, 30, 40, 50 ose 60 sekonda, plus ∞. Serveri i pranon
  vetëm këto vlera; çdo tjetër hidhet tej dhe ruhet e mëparshmja.
- Raundi mbaron kur qëllojnë të gjithë, kur mbaron koha, ose kur hosti e ndërpret.
- Nëse hosti shkëputet, hosti kalon automatikisht te lojtari tjetër i lidhur.

Transporti është SSE (`/api/stream`) plus `POST /api/action` — pa WebSocket, pa varësi.

## Të luash me shokë jashtë rrjetit tënd

Serveri lidhet vetëm në `localhost`. Në të njëjtin WiFi, jepi shokëve
`http://IP-JA-JOTE-LOKALE:8765/multiplayer.html`. Për internet duhet një tunel
(`cloudflared tunnel --url http://localhost:8765` ose ngrok) — dhe mos harro ta shtosh
adresën e tunelit në kufizimet e kyçit të Google.

## Kufiri i Kosovës

Nga OpenStreetMap, relation 2088990, i thjeshtuar në 322 pika. Sipërfaqja e llogaritur
del 10 891 km² kundrejt 10 887 km² zyrtare. Panoramat jashtë poligonit hidhen tej gjatë
zgjedhjes, dhe ecja bllokohet në kufi.

## Pikëzimi

Konvencioni i GeoGuessr-it, jo i improvizuar:

```
S = 5000 · e^(−10d/D)
D = diagonalja e drejtkëndëshit kufizues, haversine me R = 6371 km
```

Për Kosovën `D` del **214 251 m**. Pragu i pikëve të plota është `max(25 m, D/100000)`,
pra **25 m**. E njëjta formulë dhe i njëjti `D` në serverin e multiplayer-it dhe në të dy
klientët me një lojtar — të verifikuar që përputhen.

| Largësia | Pikë |
|---|---|
| ≤ 25 m | 5 000 |
| 300 m | 4 931 |
| 1 km | 4 772 |
| 10 km | 3 135 |
| 50 km | 485 |
| 100 km | 47 |

## Atribuimi

- Kufiri i Kosovës: [OpenStreetMap](https://www.openstreetmap.org/relation/2088990), ODbL.
- Pllakat e hartës në versionin pa kartë: OpenStreetMap, ODbL.
- Imazhet në `mapillary.html`: [Mapillary](https://www.mapillary.com/), CC BY-SA. Atribuimi
  brenda viewer-it është kërkesë licence dhe nuk fiket.
- Street View dhe hartat në dy variantet tjera: Google.

## Licenca

MIT — shih [LICENSE](LICENSE).
