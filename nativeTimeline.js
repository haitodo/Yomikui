(() => {
  // These columns run X's own web app directly inside the dashboard.
  if (window === window.top || window.parent !== window.top) return;
  let deckPath;
  try {
    deckPath = window.parent.location.pathname;
  } catch {
    return;
  }
  if (deckPath !== '/yomikui/status/0' && deckPath !== '/yomikui/status/0/') return;

  const telemetrySwitches = [
    'responsive_web_scribe_nested_quoted_tweet_impression_enabled',
    'responsive_web_scribe_conversation_reply_dwell_linger_enabled',
    'responsive_web_scribe_linger_fair_view_time_enabled',
  ];

  const bootstrapKey = '__INITIAL_STATE__';
  if (Object.hasOwn(window, bootstrapKey)) return;

  // X assigns this state before creating its store and then deletes the global.
  Object.defineProperty(window, bootstrapKey, {
    configurable: true,
    set(state) {
      Object.defineProperty(window, bootstrapKey, {
        value: state,
        writable: true,
        enumerable: true,
        configurable: true,
      });

      try {
        const settings = state?.featureSwitch;
        const overrides = settings?.customOverrides;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;

        for (const name of telemetrySwitches) {
          const value = overrides[name] ?? settings.user?.config?.[name]?.value ?? settings.defaultConfig?.[name]?.value;
          // The legacy client consults these overrides ahead of server flags.
          if (typeof value === 'boolean') Reflect.set(overrides, name, false);
        }
      } catch {
        // Leave startup usable if X changes the shape of its state.
      }
    },
  });
})();
