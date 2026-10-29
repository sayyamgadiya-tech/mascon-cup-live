// Firebase project: ahore-mascon-cup-2026 (sayyamgadiya@gmail.com)
window.MASCON_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBv8PYkcXsOSrNxsIkMVn-_EYo0Hrm0Yqg",
    authDomain: "ahore-mascon-cup-2026.firebaseapp.com",
    projectId: "ahore-mascon-cup-2026",
    storageBucket: "ahore-mascon-cup-2026.firebasestorage.app",
    messagingSenderId: "964915895452",
    appId: "1:964915895452:web:19f1a2c12a8ae8b8082159"
  },
  // The scorer account in Firebase Authentication. Its password is the scorer PIN.
  scorerEmail: "scorer@masconcup.app",
  // Look of the site: "black", "stadium" (navy + light), "night" (dark navy), "pitch" (green), "charcoal" (black header, white page)
  theme: "black",
  // Tournament logo shown in the header and on the welcome screen (file in the "brand" folder). Leave "" for the gold ball.
  appLogo: "sajym.png",
  // Welcome screen shown each time someone opens the link (once per visit). Logos go in the "brand" folder.
  welcome: {
    enabled: false,   // switch on once the sponsor logos are in
    organiser: "Organised by Sri Ahore Jain Pravasi Sangh, Bengaluru",
    title: "Welcome to the Ahore Mascon Cup 2026",
    message: "Live scores, points table, player stats and the fantasy league, all in one place.",
    sponsors: [
      { role: "Title sponsor", name: "Mascon Innovative Lighting", logo: "mascon-dark.png", dark: true },
      { role: "Food partner", name: "Food sponsor", logo: "" }
    ],
    seconds: 5
  },
  // Sponsor strip under the header. Add a name, or a logo file placed in this folder (e.g. "mascon.png").
  sponsors: [
    { name: "Mascon", logo: "brand/mascon-clear.png" }
  ]
};
