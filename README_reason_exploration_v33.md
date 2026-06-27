# v33 Exploration cleanup

- Removed local grammarEvaluate/EXACT from scoring path.
- All board candidates are judged by Strict Link Grammar API only.
- Candidate exploration lowercases non-I words before Link Grammar checks to avoid false proper-noun parses such as `happy Am`.
- Success image panel is closed at the start of every new placement and only opened for scored complete sentences.
- On success, short NG candidates fully contained in the successful route are suppressed, so `I am happy` does not show a misleading `Am happy -> happy Am` reason.
