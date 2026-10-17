// The lead chat is the daemon's own page (it holds the machine token and the permission prompts); this screen frames it.
// `say` pre-fills its message box (the Home prompt hands its text over this way).
export function Lead({ say = '' }: { say?: string }) {
  return (
    <section className="screen on page">
      <div className="lead-frame">
        <iframe title="Lead" src={say ? `/lead?say=${encodeURIComponent(say)}` : '/lead'} />
      </div>
    </section>
  );
}
