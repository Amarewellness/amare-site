function Bone({ className }: { className: string }) {
  return <span className={`sk ${className}`} aria-hidden="true" />;
}

export function HomeCardsSkeleton() {
  return (
    <div className="home-skel" aria-hidden="true">
      <div className="home-meter">
        <span className="sk home-skel__ring" />
        <div className="home-meter__copy">
          <Bone className="home-skel__line home-skel__line--sm" />
          <Bone className="home-skel__line home-skel__line--lg" />
        </div>
      </div>
      <section className="card home-next">
        <Bone className="home-skel__line home-skel__line--md" />
        <Bone className="home-skel__line home-skel__line--sm" />
        <Bone className="home-skel__line home-skel__line--xl" />
        <Bone className="home-skel__btn" />
      </section>
      <div className="home-page__actions">
        <Bone className="home-skel__btn home-skel__btn--full" />
        <div className="home-page__actions-row">
          <Bone className="home-skel__btn home-skel__btn--full" />
          <Bone className="home-skel__btn home-skel__btn--full" />
        </div>
      </div>
    </div>
  );
}

export function ScheduleRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="mb-schedule-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="mb-schedule-slot">
          <Bone className="sched-skel__time" />
          <div className="mb-schedule-slot__body">
            <Bone className="sched-skel__title" />
            <Bone className="sched-skel__meta" />
          </div>
          <div className="mb-schedule-slot__actions">
            <Bone className="sched-skel__book" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MyClassesRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="my-classes-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card my-class-card my-class-card--skel">
          <div className="my-class-card__head">
            <div className="my-class-card__head-text">
              <Bone className="class-skel__title" />
              <Bone className="class-skel__meta" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
