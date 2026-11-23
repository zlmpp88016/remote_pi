/// Opt-in scalar counters for tests and the isolated profile entry.
/// No message identifiers, content, tokens, or event history are retained.
abstract final class ChatRenderMetrics {
  static bool enabled = false;
  static int messageSnapshots = 0;
  static int projections = 0;
  static int groupingPasses = 0;
  static int userBuilds = 0;
  static int assistantBuilds = 0;
  static int markdownBuilds = 0;
  static int markdownCreations = 0;

  static Map<String, int> get snapshot => {
    'messageSnapshots': messageSnapshots,
    'projections': projections,
    'groupingPasses': groupingPasses,
    'userBuilds': userBuilds,
    'assistantBuilds': assistantBuilds,
    'markdownBuilds': markdownBuilds,
    'markdownCreations': markdownCreations,
  };

  static void reset() {
    messageSnapshots = projections = groupingPasses = userBuilds =
        assistantBuilds = markdownBuilds = markdownCreations = 0;
  }
}
