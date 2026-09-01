import { useEffect, useState } from "react";
import { HOME_CAROUSEL_SLIDES } from "../lib/studio-images";

const INTERVAL_MS = 2000;

export function StudioImageCarousel() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setIndex((n) => (n + 1) % HOME_CAROUSEL_SLIDES.length);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const slide = HOME_CAROUSEL_SLIDES[index];
  const subtitle = "subtitle" in slide ? slide.subtitle : undefined;

  return (
    <div className="studio-carousel" aria-roledescription="carousel" aria-label="The studio">
      {HOME_CAROUSEL_SLIDES.map((item, i) => (
        <img
          key={item.src}
          src={item.src}
          alt={item.name}
          className={i === index ? "is-active" : undefined}
        />
      ))}
      <div className="studio-carousel__caption-wrap">
        <p className="studio-carousel__caption">{slide.name}</p>
        {subtitle ? <p className="studio-carousel__subtitle">{subtitle}</p> : null}
      </div>
      <div className="studio-carousel__dots" aria-hidden="true">
        {HOME_CAROUSEL_SLIDES.map((item, i) => (
          <span key={item.src} className={i === index ? "is-active" : undefined} />
        ))}
      </div>
    </div>
  );
}
