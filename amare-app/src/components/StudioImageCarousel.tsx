import { useEffect, useState } from "react";
import { STUDIO_CLASS_IMAGES } from "../lib/studio-images";

const INTERVAL_MS = 2000;

export function StudioImageCarousel() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setIndex((n) => (n + 1) % STUDIO_CLASS_IMAGES.length);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="studio-carousel" aria-roledescription="carousel" aria-label="The studio">
      {STUDIO_CLASS_IMAGES.map((slide, i) => (
        <img
          key={slide.name}
          src={slide.src}
          alt={slide.name}
          className={i === index ? "is-active" : undefined}
        />
      ))}
      <p className="studio-carousel__caption">{STUDIO_CLASS_IMAGES[index].name}</p>
      <div className="studio-carousel__dots" aria-hidden="true">
        {STUDIO_CLASS_IMAGES.map((slide, i) => (
          <span key={slide.name} className={i === index ? "is-active" : undefined} />
        ))}
      </div>
    </div>
  );
}
