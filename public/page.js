// Counts a view for standalone pages (privacy, terms, 404), honoring Do Not Track.
window.ShelfMonitor?.pageView(document.body.dataset.page || window.location.pathname);
