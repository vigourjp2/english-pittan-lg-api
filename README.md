# English Pittan LG API / Frontend v54

Root fix over v53: final HF grammar verification for reason display suggestions is executed in parallel chunks instead of one-by-one. This preserves the main `/check` gate consistency while avoiding reason-job timeout from sequential rejected HF candidates.

Output zip: english_reason_parallel_hf_filter_v54.zip
