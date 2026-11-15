export const surveyVersion = 'aol-programs-v1';
export const rulesVersion = 'aol-routing-v1';
export const timeZone = 'America/Edmonton';
export const thankYou = 'Thank you for helping shape our AOL Programs follow-ups!';
export const maxCommentLength = 240;
export const maxNameLength = 80;

const option = (id, label) => ({ id, label });
export const attendance = [
  option('never', 'Zero. I have never joined.'),
  option('lapsed', 'Zero. I have joined before.'),
  option('once', 'One'),
  option('two_plus', 'Two or more'),
];
export const barriers = [
  option('day', 'Days offered'),
  option('time', 'Times offered'),
  option('commitments', 'Work or family commitments'),
  option('travel', 'Distance, transit or parking'),
  option('venue', 'The venue or space'),
  option('access', 'Health or access needs'),
  option('details', 'Hard to find session details'),
  option('unclear', 'Unsure what to expect'),
  option('solo', 'I prefer practising on my own'),
  option('other', 'Something else'),
  option('none', 'Nothing gets in the way'),
  option('skip', 'Prefer to skip'),
];
export const exclusiveBarriers = ['none', 'skip'];
export const priority = [
  option('guided', 'Guided group practice'),
  option('refresher', 'A refresher on the basics'),
  option('questions', 'Time to ask a teacher'),
  option('connect', 'Time to meet other graduates'),
  option('shorter', 'A shorter session'),
  option('no_preference', 'No preference right now'),
];
export const days = [
  option('weekday', 'Weekday'),
  option('saturday', 'Saturday'),
  option('sunday', 'Sunday'),
  option('any_day', 'Any day'),
];
export const times = [
  option('morning', 'Morning'),
  option('afternoon', 'Afternoon'),
  option('evening', 'Evening'),
  option('any_time', 'Any time'),
];
export const formats = [
  option('in_person', 'In person'),
  option('online', 'Online'),
  option('either', 'Either'),
];

export const survey = {
  version: surveyVersion,
  timeZone,
  title: 'AOL Programs follow-ups',
  introduction: 'Help us make AOL Programs follow-ups easier to join. Get a suggested next step when you share your feedback.',
  privacyNote: 'Your feedback goes to the AOL Programs follow-up team. You can respond without giving your name or email.',
  submitLabel: 'Share feedback',
  questions: [
    {
      id: 'attendance',
      type: 'single',
      prompt: 'How many AOL program follow-ups have you joined in the past 30 days?',
      required: true,
      options: attendance,
    },
    {
      id: 'barriers',
      type: 'multiple',
      prompt: 'What makes it harder to join?',
      required: true,
      maxSelections: 2,
      hint: 'Choose up to 2.',
      options: barriers,
      exclusiveOptions: exclusiveBarriers,
      otherOption: 'other',
      otherHint: 'You can tell us more in the last box.',
    },
    {
      id: 'priority',
      type: 'single',
      prompt: 'What would you most like from a follow-up?',
      required: true,
      options: priority,
    },
    {
      id: 'schedule',
      type: 'group',
      prompt: 'Which day and time usually work for you?',
      hint: 'Your local time. You can choose one or both.',
      required: false,
      fields: [
        { id: 'day', label: 'Day', type: 'single', required: false, options: days },
        { id: 'time', label: 'Time', type: 'single', required: false, options: times },
      ],
    },
    {
      id: 'format',
      type: 'single',
      prompt: 'How would you prefer to join?',
      required: false,
      options: formats,
    },
    {
      id: 'comment',
      type: 'text',
      prompt: 'Anything else that would help?',
      hint: 'A preferred area or an idea we missed is welcome. Please leave out other people’s names, contact info and health details.',
      required: false,
      maxLength: maxCommentLength,
    },
    {
      id: 'name',
      type: 'text',
      input: 'line',
      prompt: 'Your name',
      hint: 'Only the AOL Programs follow-up manager sees it. Leave blank to stay anonymous.',
      required: false,
      maxLength: maxNameLength,
      autocomplete: 'name',
    },
  ],
};

export const recommendationLabels = {
  teacher_support: 'Teacher Support',
  stay_connected: 'Stay Connected',
  ask_volunteer: 'Volunteer Support',
  online_options: 'Online Options',
  find_sessions: 'Find Sessions',
  group_practice: 'Group Practice',
};

export const defaultDestinations = {
  followups: 'https://www.artofliving.org/ca-en/happiness-program-follow-up-sessions',
  volunteer: 'https://www.artofliving.org/ca-en/canada-centers',
  teacher: 'https://www.artofliving.org/ca-en/canada-centers',
  online: null,
};
