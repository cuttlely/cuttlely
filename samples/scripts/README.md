# Upload sampler

`sample_csv.py` reads a CSV or TSV from a path and prints a short sample: size, row count, headers, the first and last five rows, and an amount-by-region aggregate when those columns exist.

It does not print the file. Stdout is capped at 4000 characters. The upload harness copies this script into a specialist workspace as `uploads/sample_csv.py` when a prediction upload is staged.

```bash
python samples/scripts/sample_csv.py /path/to/file.csv
```

No credentials. A spreadsheet over 1 MB, or a spreadsheet with more than 1000 rows, is not pasted into the chat. The specialist runs this script, or an equivalent sample, on the staged path.
