# 帰属表示

このリポジトリのコードとデータは MIT ライセンスで配布する。
ライセンス全文は [LICENSE](LICENSE) にある。

生成されるカレンダーとデータには、以下の第三者リポジトリ由来の会議情報が含まれる。
いずれも MIT ライセンスであり、二次配布にあたって著作権表示と許諾表示を保持する必要がある。
本ファイルがその表示を兼ねる。

## ccfddl/ccf-deadlines

- リポジトリ: https://github.com/ccfddl/ccf-deadlines
- ライセンス: MIT License
- 著作権表示: Copyright (c) 2021 CCFDDL
- 利用範囲: `conference/<分野>/*.yml` に収録された会議名・開催情報・締切・ランク情報。

## huggingface/ai-deadlines

- リポジトリ: https://github.com/huggingface/ai-deadlines
- ライセンス: MIT License
- 著作権表示: Copyright (c) 2025 Hugging Face
- 利用範囲: `src/data/conferences/*.yml` に収録された会議名・開催情報・締切。

## 上記以外のデータ

`data/extra.yaml` に収録した会議は本リポジトリで独自に整備したものであり、
本リポジトリの MIT ライセンスに従う。

## MIT License (両上流に共通の本文)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 免責

締切情報は上流データと推定処理に依存しており、正確性を保証しない。
投稿にあたっては必ず各会議の公式サイトで最終確認すること。
