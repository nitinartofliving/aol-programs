// Journey catalog: the order of the core path and the extra programs.
export const corePath = ['Intro Talk', 'Part 1', 'Sahaj', 'Part 2', 'Sanyam 1', 'Sanyam 2'];
export const extraPrograms = ['VTP', 'TTC', 'Yoga TTC', 'Guru Pooja Part 1', 'Guru Pooja Part 2'];
export const journeySteps = [...corePath, ...extraPrograms];
// Programs an event can be for. Satsang and Other are gatherings, not journey steps.
export const eventPrograms = [...journeySteps, 'Satsang', 'Other'];

export const outcomes = ['Interested', 'Not now', 'No answer', 'Messaged'];

export const limits = {
  name: 80, phone: 30, email: 120, goal: 200, note: 500, title: 100, place: 150, teacher: 80, description: 600,
  question: 200, answer: 1500, source: 150,
};

// Demo answers carried over from SevaAssist. They are fictional and must be
// replaced with approved content before real use.
export const demoKnowledge = [
  {
    question: 'How do I register a participant for an event?',
    alternatives: [],
    answer: "Open the event registration portal, select the appropriate event, enter the participant's information with their consent, and confirm their registration.",
    source: 'DEMO-001: Sample Event Registration Guide',
  },
  {
    question: 'How can I become a volunteer?',
    alternatives: ['How do I volunteer?', 'How can I sign up as a volunteer?'],
    answer: 'Contact the volunteer coordinator, share your interests and availability, and complete any required orientation before accepting an assignment.',
    source: 'DEMO-002: Sample Volunteer Onboarding Guide',
  },
  {
    question: 'Where can I find training materials?',
    alternatives: [],
    answer: "Access the organization's approved volunteer resource library or contact your coordinator for the appropriate training materials.",
    source: 'DEMO-003: Sample Training Resources Guide',
  },
  {
    question: 'What are the responsibilities of a volunteer?',
    alternatives: ['What do volunteers do?', 'What is expected of a volunteer?'],
    answer: 'In this demonstration scenario, volunteers help with event preparation, welcoming participants, sharing approved information, and communicating with their coordinator.',
    source: 'DEMO-004: Fictional Volunteer Responsibilities Guide',
  },
];
