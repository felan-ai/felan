export interface RageWordEntry {
  word: string;
  group: string;
}

export interface RageMatch {
  word: string;
  group: string;
}

export const RAGE_WORDLIST: RageWordEntry[] = [
  { word: "fuck",         group: "fuck"    }, { word: "fucking",      group: "fuck"    },
  { word: "fucked",       group: "fuck"    }, { word: "fucker",       group: "fuck"    },
  { word: "motherfucker", group: "fuck"    }, { word: "clusterfuck",  group: "fuck"    },
  { word: "fuckup",       group: "fuck"    }, { word: "bullshit",     group: "shit"    },
  { word: "shit",         group: "shit"    }, { word: "shitty",       group: "shit"    },
  { word: "shithead",     group: "shit"    }, { word: "shithole",     group: "shit"    },
  { word: "asshole",      group: "ass"     }, { word: "jackass",      group: "ass"     },
  { word: "dumbass",      group: "ass"     }, { word: "ass",          group: "ass"     },
  { word: "goddamn",      group: "damn"    }, { word: "goddammit",    group: "damn"    },
  { word: "dammit",       group: "damn"    }, { word: "damn",         group: "damn"    },
  { word: "bitches",      group: "bitch"   }, { word: "bitch",        group: "bitch"   },
  { word: "bastard",      group: "bastard" },
  { word: "pissed",       group: "piss"    }, { word: "piss",         group: "piss"    },
  { word: "dickhead",     group: "dick"    }, { word: "dick",         group: "dick"    },
  { word: "crappy",       group: "crap"    }, { word: "crap",         group: "crap"    },
  { word: "hell",         group: "hell"    },
  { word: "wtf",          group: "wtf"     }, { word: "stfu",         group: "stfu"    },
  { word: "cunt",         group: "cunt"    },
];

const PATTERN = new RegExp(
  `\\b(${RAGE_WORDLIST.map(w => w.word).join("|")})\\b`,
  "gi"
);

const WORD_MAP = new Map<string, string>(
  RAGE_WORDLIST.map(w => [w.word.toLowerCase(), w.group])
);

export function detectRage(text: string): RageMatch[] {
  const hits: RageMatch[] = [];
  for (const m of text.toLowerCase().matchAll(PATTERN)) {
    const group = WORD_MAP.get(m[0]);
    if (group) hits.push({ word: m[0], group });
  }
  return hits;
}

export function wordCount(): number {
  return RAGE_WORDLIST.length;
}
