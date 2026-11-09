import { NextResponse } from 'next/server';

// Zde se změní spoj
const SECTION_ID = 8730781316;
const FROM_STATION_ID = 372825002;
const TO_STATION_ID = 3741302011;

const CLASS_NAMES: Record<string, string> = {
  C0: 'Standard',
  TRAIN_LOW_COST: 'Low Cost',
  C1: 'Relax',
  C2: 'Business',
};

// Paměť proti spamování (aby ti na stejná sedadla nepřišlo 60 mailů za hodinu)
let lastNotifiedSignature = '';

// Přesná mapa sousedních sedadel pro vozy v této soupravě
function getAdjacentPairsForDeck(deckName: string): [number, number][] {
  const pairs: [number, number][] = [];

  // Velkoprostor 2+2: Astra (Vůz 2) a Bp2xx Low Cost (Vozy 1 a 5)
  if (deckName.includes('Astra') || deckName.includes('Bp2xx')) {
    for (let d = 0; d <= 90; d += 10) {
      pairs.push([d + 1, d + 2], [d + 3, d + 4], [d + 5, d + 6], [d + 7, d + 8]);
    }
    pairs.push([101, 102], [103, 104]);
  }
  // Kupé po 6 místech: Vuz Bk Standard (Vozy 3 a 7)
  else if (deckName.includes('Bk')) {
    for (let d = 0; d <= 60; d += 10) {
      pairs.push([d + 1, d + 3], [d + 3, d + 5], [d + 2, d + 4], [d + 4, d + 6]);
    }
  }
  // Kupé Business + Relax: Vuz A (Vůz 4)
  else if (deckName.includes('Vuz A')) {
    for (let d = 0; d <= 30; d += 10) {
      pairs.push([d + 1, d + 3], [d + 2, d + 4]); // Business (4 místa)
    }
    for (let d = 40; d <= 90; d += 10) {
      pairs.push([d + 1, d + 3], [d + 3, d + 5], [d + 2, d + 4], [d + 4, d + 6]); // Relax (6 míst)
    }
  }
  // Velkoprostor Relax 2+1: Vuz Bm3xx (Vůz 6)
  else if (deckName.includes('Bm3xx')) {
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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // Pokud dáš do URL ?notifyAnyTwo=true, pošle mail i když budou 2 místa každé jinde
    const notifyAnyTwo = searchParams.get('notifyAnyTwo') === 'true';

    // Zeptáme se API na všechny 4 třídy najednou
    const seatClasses = ['C0', 'TRAIN_LOW_COST', 'C1', 'C2'];

    const responses = await Promise.all(
      seatClasses.map((seatClass) =>
        fetch('https://brn-ybus-pubapi.sa.cz/restapi/routes/freeSeats', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/1.2.0+json',
            'X-Lang': 'cs',
            'X-Currency': 'CZK',
            'X-Application-Origin': 'WEB',
            'Origin': 'https://regiojet.cz',
            'Referer': 'https://regiojet.cz/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0',
          },
          body: JSON.stringify({
            sections: [
              {
                sectionId: SECTION_ID,
                fromStationId: FROM_STATION_ID,
                toStationId: TO_STATION_ID,
              },
            ],
            seatPreference: {
              seatClass,
              tariffs: ['CZECH_STUDENT_PASS_26'],
            },
          }),
          cache: 'no-store',
        }).then((r) => (r.ok ? r.json() : null))
      )
    );

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

    const foundAdjacent: { isStandard: boolean; text: string }[] = [];
    const allFreeSingleSeats: string[] = [];

    for (const wagon of Array.from(wagonMap.values()).sort((a, b) => a.wagonNumber - b.wagonNumber)) {
      const pairs = getAdjacentPairsForDeck(wagon.deckName);

      for (const [seatIndex, info] of wagon.freeSeats.entries()) {
        const cName = CLASS_NAMES[info.seatClass] || info.seatClass;
        allFreeSingleSeats.push(`Vůz ${wagon.wagonNumber} (třída ${cName}): sedadlo ${seatIndex}`);
      }

      for (const [seatA, seatB] of pairs) {
        if (wagon.freeSeats.has(seatA) && wagon.freeSeats.has(seatB)) {
          const infoA = wagon.freeSeats.get(seatA)!;
          const className = CLASS_NAMES[infoA.seatClass] || infoA.seatClass;
          const isStandard = infoA.seatClass === 'C0';
          const note = infoA.constraint ? ` (${infoA.constraint})` : '';

          foundAdjacent.push({
            isStandard,
            text: `Třída ${className} | Vůz č. ${wagon.wagonNumber} (${wagon.deckName}) -> sedadla ${seatA} a ${seatB} (VEDLE SEBE)${note}`,
          });
        }
      }
    }

    foundAdjacent.sort((a, b) => Number(b.isStandard) - Number(a.isStandard));

    const areSeatsTogether = foundAdjacent.length > 0;
    const statusSummary = areSeatsTogether
      ? `🎉 ANO! Nalezena místa VEDLE SEBE (${foundAdjacent.length} dvojic).`
      : allFreeSingleSeats.length >= 2
      ? `❌ NEJSOU vedle sebe (ve vlaku jsou volná ${allFreeSingleSeats.length} místa, ale každé jinde: ${allFreeSingleSeats.join(', ')}).`
      : `❌ NEJSOU vedle sebe (celkem volných míst ve vlaku: ${allFreeSingleSeats.length}).`;

    // Rozhodnutí, zda poslat e-mail
    const shouldNotify = areSeatsTogether || (notifyAnyTwo && allFreeSingleSeats.length >= 2);
    const currentSignature = areSeatsTogether
      ? `ADJ:${foundAdjacent.map((f) => f.text).join('|')}`
      : `SEP:${allFreeSingleSeats.join('|')}`;

    let emailStatus = 'no_need_to_send';

    if (shouldNotify && currentSignature !== lastNotifiedSignature) {
      if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
        const hasStandard = foundAdjacent.some((f) => f.isStandard);
        const subject = areSeatsTogether
          ? `${hasStandard ? '⭐ [STANDARD]' : '🚆 [JINÁ TŘÍDA]'} Jsou volná místa VEDLE SEBE (14:05 Vídeň)!`
          : `⚠️ 2 volná místa ve vlaku (NEJSOU vedle sebe - každé jinde)`;

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
                areSeatsTogether ? '<span style="color:green;font-weight:bold;">ANO!</span>' : '<span style="color:red;font-weight:bold;">NE (každé jinde)</span>'
              }</p>
              
              ${
                areSeatsTogether
                  ? `<h3>Nalezené dvojice VEDLE SEBE:</h3>
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
      // Pokud se místa zase obsadí, vynulujeme paměť, aby příště e-mail znovu přišel
      lastNotifiedSignature = '';
    } else {
      emailStatus = 'already_notified_for_these_exact_seats';
    }

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }),
      jsouMistaVedleSebe: areSeatsTogether,
      zprava: statusSummary,
      dvojiceVedleSebe: foundAdjacent.map((f) => f.text),
      vsechnaVolnaMistaVeVlaku: allFreeSingleSeats,
      emailStatus,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}