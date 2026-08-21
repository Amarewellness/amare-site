import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AppHero } from "../components/AppHero";
import { ApiError } from "../api/client";
import {
  CONTACT_TOPICS,
  STUDIO_HOURS,
  STUDIO_INSTAGRAM_URL,
  STUDIO_PHONE_DISPLAY,
  STUDIO_PHONE_TEL,
  STUDIO_WHATSAPP_URL,
  openExternalUrl,
  submitContactMessage,
} from "../lib/studio-contact";
import { STUDIO_ADDRESS_LINE, openStudioDirections } from "../lib/studio-maps";

export function ContactScreen() {
  const { profile } = useAuth();

  const defaults = useMemo(
    () => ({
      name: String(profile?.name || "").trim(),
      email: String(profile?.email || "").trim(),
    }),
    [profile?.name, profile?.email],
  );
  const [name, setName] = useState(defaults.name);
  const [email, setEmail] = useState(defaults.email);

  useEffect(() => {
    if (defaults.name) setName((cur) => cur || defaults.name);
    if (defaults.email) setEmail((cur) => cur || defaults.email);
  }, [defaults.name, defaults.email]);
  const [topic, setTopic] = useState<(typeof CONTACT_TOPICS)[number]["value"]>("general");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitContactMessage({ name, email, topic, message });
      setSent(true);
      setMessage("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : "We couldn’t send that. Try again, or call / WhatsApp the studio.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="contact-page">
      <AppHero />
      <p className="purchase-page__back">
        <Link to="/profile">Profile</Link>
      </p>
      <h2 className="schedule-page__title">Contact the studio</h2>
      <p className="contact-page__lede">
        AMARÉ Wellness Studio — Hallandale, Florida. For a quick reply, call or WhatsApp. You can
        also send a message below.
      </p>

      <p className="contact-page__hours">
        <strong>Hours</strong>
        {STUDIO_HOURS}
      </p>

      <div className="contact-actions">
        <a className="contact-action" href={`tel:${STUDIO_PHONE_TEL}`}>
          <span>Phone</span>
          <strong>{STUDIO_PHONE_DISPLAY}</strong>
        </a>
        <button
          type="button"
          className="contact-action"
          onClick={() => void openExternalUrl(STUDIO_WHATSAPP_URL)}
        >
          <span>WhatsApp</span>
          <strong>{STUDIO_PHONE_DISPLAY}</strong>
        </button>
        <button
          type="button"
          className="contact-action"
          onClick={() => void openExternalUrl(STUDIO_INSTAGRAM_URL)}
        >
          <span>Instagram</span>
          <strong>@amare__wellness</strong>
        </button>
      </div>

      <section className="card contact-address">
        <h3>Address</h3>
        <p>{STUDIO_ADDRESS_LINE}</p>
        <button type="button" className="btn" onClick={() => void openStudioDirections()}>
          Get directions
        </button>
      </section>

      <section className="card contact-form-card">
        <h3>Send a message</h3>
        {sent ? (
          <p className="success-banner" role="status">
            Thank you — your message was sent. We’ll get back to you as soon as we can.
          </p>
        ) : null}
        {error ? <p className="error-banner">{error}</p> : null}
        <form className="contact-form" onSubmit={(e) => void onSubmit(e)}>
          <label htmlFor="contact-name">Name</label>
          <input
            id="contact-name"
            name="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="contact-email">Email</label>
          <input
            id="contact-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="contact-topic">Topic</label>
          <select
            id="contact-topic"
            name="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value as typeof topic)}
          >
            {CONTACT_TOPICS.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
          <label htmlFor="contact-message">Message</label>
          <textarea
            id="contact-message"
            name="message"
            rows={5}
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </div>
  );
}
