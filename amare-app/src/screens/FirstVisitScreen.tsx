import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { Link } from "react-router-dom";
import { AppHero } from "../components/AppHero";
import { STUDIO_CLASS_IMAGES } from "../lib/studio-images";

const FAQ_URL = "https://www.amarewellness.com/faq";

const EQUIPMENT = [
  {
    name: "Reformer",
    image: STUDIO_CLASS_IMAGES[0].src,
    bring: [{ text: "Grip socks", tag: "Required" as const }],
    studioLabel: "At the studio",
    studio: ["Grip socks for sale in beautiful designs if you need a pair"],
  },
  {
    name: "Mat",
    image: STUDIO_CLASS_IMAGES[1].src,
    bring: [
      { text: "Long towel to place over the mat" },
      { text: "Your own mat", tag: "Optional" as const },
    ],
    studioLabel: "We provide",
    studio: ["Mats for every class", "Towels for sale and towel rentals if needed"],
  },
];

async function openFaq() {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: FAQ_URL });
    return;
  }
  window.open(FAQ_URL, "_blank", "noopener,noreferrer");
}

export function FirstVisitScreen() {
  return (
    <div className="first-visit-page">
      <AppHero />
      <p className="purchase-page__back">
        <Link to="/">Home</Link>
      </p>
      <h2 className="schedule-page__title">First visit</h2>
      <p className="first-visit-page__lede">
        If it’s your first time at AMARÉ, welcome. Here’s what to know before class.
      </p>

      <section className="card first-visit-arrive">
        <p className="first-visit-arrive__time">
          10–15<span>min early</span>
        </p>
        <h3>Before class</h3>
        <p className="card__meta">
          Please arrive early so you can settle in, check in, and get ready for class without
          feeling rushed.
        </p>
        <ul>
          <li>Relax in our comfortable seating area</li>
          <li>Check in at the front desk</li>
          <li>Get settled before class begins</li>
        </ul>
      </section>

      <h3 className="first-visit-page__section">Equipment</h3>
      <p className="first-visit-page__lede">
        What you need depends on the class you book. Here’s what to bring — and what we already
        have ready for you.
      </p>

      {EQUIPMENT.map((item) => (
        <section key={item.name} className="card first-visit-equip">
          <div className="first-visit-equip__thumb">
            <img src={item.image} alt="" width={400} height={300} />
          </div>
          <h3>{item.name}</h3>
          <p className="first-visit-equip__label">You bring</p>
          <ul>
            {item.bring.map((row) => (
              <li key={row.text}>
                {row.text}
                {row.tag ? <span className="first-visit-tag">{row.tag}</span> : null}
              </li>
            ))}
          </ul>
          <p className="first-visit-equip__label">{item.studioLabel}</p>
          <ul>
            {item.studio.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}

      <aside className="card first-visit-notice">
        <h3>Pregnant, injured, or not sure?</h3>
        <p className="card__meta">
          Review the notes on our FAQ page and let your instructor know before class begins.
        </p>
        <button type="button" className="btn btn--ghost" onClick={() => void openFaq()}>
          Read the FAQ
        </button>
      </aside>
    </div>
  );
}
