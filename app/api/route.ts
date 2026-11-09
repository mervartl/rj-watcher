import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Zde změnit spoj
const ROUTE_ID = '8730781316';
const SECTION_ID = 8730781316;
const FROM_STATION_ID = 372825002;
const TO_STATION_ID = 3741302011;
const TARIFF = 'CZECH_STUDENT_PASS_26';
const DEPARTURE_DATE = '2026-11-13';
const FROM_LOCATION_ID = '372842000'; // město Praha (city)
const TO_LOCATION_ID = '10202052';    // město Vídeň (city)

const CLASS_NAMES: Record<string, string> = {
  C0: 'Standard',
  TRAIN_LOW_COST: 'Low Cost',
  C1: 'Relax',
  C2: 'Business',
};

const COMMON_HEADERS = {
  'Content-Type': 'application/1.1.0+json',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'cs,sk;q=0.9,en-US;q=0.8,en;q=0.7',
  'X-Lang': 'cs',
  'X-Currency': 'CZK',
  'X-Application-Origin': 'WEB',
  'Origin': 'https://regiojet.cz',
  'Referer': 'https://regiojet.cz/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0',
};

// Paměť proti spamování
let lastNotifiedSignature = '';

function getAdjacentPairsForDeck(deckName: string): [number, number][] {
  const pairs: [number, number][] = [];

  if (deckName.includes('Astra') || deckName.includes('Bp2xx')) {
    for (let d = 0; d <= 90; d += 10) {
      pairs.push([d + 1, d + 2], [d + 3, d + 4], [d + 5, d + 6], [d + 7, d + 8]);
    }
    pairs.push([101, 102], [103, 104]);
  } else if (deckName.includes('Bk')) {
    for (let d = 0; d <= 60; d += 10) {
      pairs.push([d + 1, d + 3], [d + 3, d + 5], [d + 2, d + 4], [d + 4, d + 6]);
    }
  } else if (deckName.includes('Vuz A')) {
    for (let d = 0; d <= 30; d += 10) {
      pairs.push([d + 1, d + 3], [d + 2, d + 4]);
    }
    for (let d = 40; d <= 90; d += 10) {
      pairs.push([d + 1, d + 3], [d + 3, d + 5], [d + 2, d + 4], [d + 4, d + 6]);
    }
  } else if (deckName.includes('Bm3xx')) {
    for (const d of [0, 10, 30, 40, 70, 80]) {
      pairs.push([d + 1, d + 2], [d + 5, d + 6]);
    }
    for (const d of [20, 60]) {
      pairs.push([d + 1, d + 2], [d + 3, d + 4]);
    }
    pairs.push([51, 52], [91, 92]);
  }

  return pairs;
}

// Rychlý check přes search endpoint — zjistí, jestli má spoj vůbec volná místa
async function checkRouteAvailability(routeId = ROUTE_ID): Promise<{
  bookable: boolean;
  freeSeatsCount: number;
  priceFrom: number;
  found: boolean;
}> {
  const searchUrl =
    `https://brn-ybus-pubapi.sa.cz/restapi/routes/search/simple` +
    `?tariffs=${TARIFF}` +
    `&toLocationType=CITY&toLocationId=${TO_LOCATION_ID}` +
    `&fromLocationType=CITY&fromLocationId=${FROM_LOCATION_ID}` +
    `&departureDate=${DEPARTURE_DATE}` +
    `&fromLocationName=&toLocationName=`;

  const res = await fetch(searchUrl, {
    headers: COMMON_HEADERS,
    cache: 'no-store',
  });

  if (!res.ok) return { bookable: false, freeSeatsCount: 0, priceFrom: 0, found: false };

  const data = await res.json();
  const route = (data.routes ?? []).find((r: any) => String(r.id) === routeId);

  if (!route) return { bookable: false, freeSeatsCount: 0, priceFrom: 0, found: false };

  return {
    found: true,
    bookable: route.bookable === true,
    freeSeatsCount: route.freeSeatsCount ?? 0,
    priceFrom: route.priceFrom ?? 0,
  };
}

// Stažení aktuálních cen pro jednotlivé třídy
async function fetchClassPrices(routeId = ROUTE_ID): Promise<Record<string, { single: number; totalForTwo: number; creditTotalForTwo?: number }>> {
  const priceMap: Record<string, { single: number; totalForTwo: number; creditTotalForTwo?: number }> = {};

  try {
    // 1. Zkusíme detail konkrétního spoje (vrací pole priceClasses pro každou třídu)
    const detailUrl = `https://brn-ybus-pubapi.sa.cz/restapi/routes/${routeId}/simple?fromStationId=${FROM_STATION_ID}&toStationId=${TO_STATION_ID}&tariffs=${TARIFF}`;
    const res = await fetch(detailUrl, { headers: COMMON_HEADERS, cache: 'no-store' });

    if (res.ok) {
      const data = await res.json();
      const priceClasses = data.priceClasses || [];
      for (const pc of priceClasses) {
        if (pc.seatClassKey && typeof pc.price === 'number') {
          priceMap[pc.seatClassKey] = {
            single: pc.price,
            totalForTwo: pc.price * 2,
            creditTotalForTwo: typeof pc.creditPrice === 'number' ? pc.creditPrice * 2 : undefined,
          };
        }
      }
    }

    // 2. Fallback: Pokud by detail nevrátil priceClasses, vezmeme priceFrom/priceTo z vyhledávání
    if (Object.keys(priceMap).length === 0) {
      const searchUrl = `https://brn-ybus-pubapi.sa.cz/restapi/routes/search/simple?tariffs=${TARIFF}&toLocationType=CITY&toLocationId=${TO_LOCATION_ID}&fromLocationType=CITY&fromLocationId=${FROM_LOCATION_ID}&departureDate=${DEPARTURE_DATE}`;
      const sRes = await fetch(searchUrl, { headers: COMMON_HEADERS, cache: 'no-store' });
      if (sRes.ok) {
        const sData = await sRes.json();
        const route = (sData.routes || []).find((r: any) => String(r.id) === routeId);
        if (route && route.priceFrom) {
          priceMap['FALLBACK'] = {
            single: route.priceFrom,
            totalForTwo: route.priceFrom * 2,
            creditTotalForTwo: route.creditPriceFrom ? route.creditPriceFrom * 2 : undefined,
          };
        }
      }
    }
  } catch (e) {
    console.error('Chyba při stahování cen:', e);
  }

  return priceMap;
}

function formatPriceText(
  seatClass: string,
  prices: Record<string, { single: number; totalForTwo: number; creditTotalForTwo?: number }>
): string {
  const p = prices[seatClass] || prices['FALLBACK'];
  if (!p) return 'cena nezjištěna';
  const creditPart = p.creditTotalForTwo ? ` (s Kreditovou jízdenkou ${p.creditTotalForTwo} Kč)` : '';
  return `${p.totalForTwo} Kč za obě jízdenky (${p.single} Kč/os.)${creditPart}`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const notifyAnyTwo = searchParams.get('notifyAnyTwo') === 'true';

    // Volitelně přepsat spoj přes ?routeId=... (defaultně použije konstantu nahoře)
    const effectiveRouteId = searchParams.get('routeId') ?? ROUTE_ID;
    const effectiveSectionId = Number(effectiveRouteId);

    // ── EARLY CHECK ──────────────────────────────────────────────────────────
    // Nejdřív zjistíme přes search endpoint, jestli vůbec má spoj volná místa.
    // Pokud ne, nevoláme zbytečně 4× /freeSeats (které by stejně vrátily "Unexpected error").
    const availability = await checkRouteAvailability(effectiveRouteId);

    if (!availability.found) {
      return NextResponse.json({
        ok: true,
        checkedAt: new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }),
        jsouMistaVedleSebe: false,
        zprava: `⚠️ Spoj ${effectiveRouteId} nebyl nalezen v search výsledcích (špatné datum nebo ID?).`,
        dvojiceVedleSebe: [],
        vsechnaVolnaMistaVeVlaku: [],
        emailStatus: 'no_need_to_send',
      });
    }

    if (!availability.bookable || availability.freeSeatsCount === 0) {
      return NextResponse.json({
        ok: true,
        checkedAt: new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }),
        jsouMistaVedleSebe: false,
        zprava: `❌ Spoj je plně obsazený (freeSeatsCount: ${availability.freeSeatsCount}, bookable: ${availability.bookable}). Čekám na uvolnění míst…`,
        dvojiceVedleSebe: [],
        vsechnaVolnaMistaVeVlaku: [],
        emailStatus: 'no_need_to_send',
      });
    }
    // ── KONEC EARLY CHECK ─────────────────────────────────────────────────────

    const seatClasses = ['C0', 'TRAIN_LOW_COST', 'C1', 'C2'];

    // Paralelně stáhneme sedadla všech 4 tříd + ceník spoje
    const [prices, ...rawResponses] = await Promise.all([
      fetchClassPrices(effectiveRouteId),
      ...seatClasses.map((seatClass) =>
        fetch('https://brn-ybus-pubapi.sa.cz/restapi/routes/freeSeats', {
          method: 'POST',
          headers: COMMON_HEADERS,
          body: JSON.stringify({
            sections: [
              {
                sectionId: effectiveSectionId,
                fromStationId: FROM_STATION_ID,
                toStationId: TO_STATION_ID,
              },
            ],
            seatPreference: {
              seatClass,
              tariffs: [TARIFF],
            },
          }),
          cache: 'no-store',
        }).then(async (r) => ({ seatClass, status: r.status, body: await r.json() }))
      ),
    ]);

    const debug = searchParams.get('debug') === 'true';

    // Pokud je debug mode, vrátíme rovnou surové odpovědi
    if (debug) {
      const detailUrl = `https://brn-ybus-pubapi.sa.cz/restapi/routes/${effectiveRouteId}/simple?fromStationId=${FROM_STATION_ID}&toStationId=${TO_STATION_ID}&tariffs=${TARIFF}`;
      const detailRes = await fetch(detailUrl, { headers: COMMON_HEADERS, cache: 'no-store' });
      const detailBody = await detailRes.json().catch(() => '(nelze parsovat)');

      return NextResponse.json({
        ok: true,
        checkedAt: new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }),
        availability,
        prices,
        detailEndpoint: { url: detailUrl, status: detailRes.status, body: detailBody },
        freeSeatsRawResponses: rawResponses,
      });
    }

    const responses = rawResponses.map((r) => (r.status >= 200 && r.status < 300 ? r.body : null));

    const wagonMap = new Map<
      number,
      {
        wagonNumber: number;
        deckName: string;
        freeSeats: Map<number, { seatClass: string; constraint: string | null }>;
      }
    >();

    for (const data of responses) {
      if (!data || !Array.isArray(data) || !data[0]?.vehicles) continue;

      for (const vehicle of data[0].vehicles) {
        const deck = vehicle.decks?.[0];
        if (!deck) continue;

        if (!wagonMap.has(vehicle.number)) {
          wagonMap.set(vehicle.number, {
            wagonNumber: vehicle.number,
            deckName: deck.name,
            freeSeats: new Map(),
          });
        }

        const wagonEntry = wagonMap.get(vehicle.number)!;
        for (const seat of deck.freeSeats || []) {
          if (seat.selectable !== false) {
            wagonEntry.freeSeats.set(seat.index, {
              seatClass: seat.seatClass,
              constraint: seat.seatConstraint,
            });
          }
        }
      }
    }

    const foundAdjacent: { isStandard: boolean; text: string; priceText: string }[] = [];
    const allFreeSingleSeats: string[] = [];

    for (const wagon of Array.from(wagonMap.values()).sort((a, b) => a.wagonNumber - b.wagonNumber)) {
      const pairs = getAdjacentPairsForDeck(wagon.deckName);

      for (const [seatIndex, info] of wagon.freeSeats.entries()) {
        const cName = CLASS_NAMES[info.seatClass] || info.seatClass;
        const pText = formatPriceText(info.seatClass, prices);
        allFreeSingleSeats.push(`Vůz ${wagon.wagonNumber} (třída ${cName}): sedadlo ${seatIndex} — cena za 2 ks: ${pText}`);
      }

      for (const [seatA, seatB] of pairs) {
        if (wagon.freeSeats.has(seatA) && wagon.freeSeats.has(seatB)) {
          const infoA = wagon.freeSeats.get(seatA)!;
          const className = CLASS_NAMES[infoA.seatClass] || infoA.seatClass;
          const isStandard = infoA.seatClass === 'C0';
          const note = infoA.constraint ? ` (${infoA.constraint})` : '';
          const priceText = formatPriceText(infoA.seatClass, prices);

          foundAdjacent.push({
            isStandard,
            priceText,
            text: `Třída ${className} | Vůz č. ${wagon.wagonNumber} (${wagon.deckName}) -> sedadla ${seatA} a ${seatB} (VEDLE SEBE)${note} | 💰 Cena: ${priceText}`,
          });
        }
      }
    }

    foundAdjacent.sort((a, b) => Number(b.isStandard) - Number(a.isStandard));

    const areSeatsTogether = foundAdjacent.length > 0;
    const statusSummary = areSeatsTogether
      ? `🎉 ANO! Nalezena místa VEDLE SEBE (${foundAdjacent.length} dvojic).`
      : allFreeSingleSeats.length >= 2
      ? `❌ NEJSOU vedle sebe (ve vlaku jsou volná ${allFreeSingleSeats.length} místa, ale každé jinde).`
      : `❌ NEJSOU vedle sebe (celkem volných míst ve vlaku: ${allFreeSingleSeats.length}).`;

    // Podpis stavu sedadel pro anti-spam
    const shouldNotify = areSeatsTogether || (notifyAnyTwo && allFreeSingleSeats.length >= 2);
    const currentSignature = areSeatsTogether
      ? `ADJ:${foundAdjacent.map((f) => f.text).join('|')}`
      : `SEP:${allFreeSingleSeats.join('|')}`;

    let emailStatus = 'no_need_to_send';

    if (shouldNotify && currentSignature !== lastNotifiedSignature) {
      if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
        const hasStandard = foundAdjacent.some((f) => f.isStandard);
        const topPrice = foundAdjacent[0]?.priceText || formatPriceText('C0', prices);

        const subject = areSeatsTogether
          ? `${hasStandard ? '⭐ [STANDARD]' : '🚆 [JINÁ TŘÍDA]'} Volná místa VEDLE SEBE (${topPrice})!`
          : `⚠️ 2 volná místa ve vlaku (NEJSOU vedle sebe)`;

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'RegioJet Hlídač <onboarding@resend.dev>',
            to: [process.env.NOTIFY_EMAIL],
            subject,
            html: `
              <h2>Stav sedadel RegioJet (Pátek 13. 11. v 14:05 Pardubice &rarr; Vídeň)</h2>
              <p style="font-size:16px;"><strong>Jsou místa vedle sebe?</strong> ${
                areSeatsTogether
                  ? '<span style="color:green;font-weight:bold;">ANO!</span>'
                  : '<span style="color:red;font-weight:bold;">NE (každé jinde)</span>'
              }</p>
              
              ${
                areSeatsTogether
                  ? `<h3>Nalezené dvojice VEDLE SEBE (včetně ceny za 2 jízdenky):</h3>
                     <ul>${foundAdjacent.map((f) => `<li><strong>${f.text}</strong></li>`).join('')}</ul>`
                  : ''
              }

              <h3>Všechna jednotlivá volná místa v celém vlaku (${allFreeSingleSeats.length}):</h3>
              <ul>
                ${allFreeSingleSeats.map((s) => `<li>${s}</li>`).join('')}
              </ul>

              <p style="margin-top:20px;">
                <a href="https://regiojet.cz/" style="display:inline-block;padding:12px 20px;background:#f5a623;color:#000;text-decoration:none;font-weight:bold;border-radius:6px;">
                  Otevřít RegioJet a koupit lístky
                </a>
              </p>
            `,
          }),
        });

        if (emailRes.ok) {
          emailStatus = 'sent_successfully';
          lastNotifiedSignature = currentSignature;
        } else {
          emailStatus = `resend_error_${emailRes.status}`;
        }
      } else {
        emailStatus = 'missing_env_variables';
      }
    } else if (!shouldNotify) {
      lastNotifiedSignature = '';
    } else {
      emailStatus = 'already_notified_for_these_exact_seats';
    }

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }),
      jsouMistaVedleSebe: areSeatsTogether,
      zprava: statusSummary,
      cenyZaDveJizdenkyPodleTrid: prices,
      dvojiceVedleSebe: foundAdjacent.map((f) => f.text),
      vsechnaVolnaMistaVeVlaku: allFreeSingleSeats,
      emailStatus,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
