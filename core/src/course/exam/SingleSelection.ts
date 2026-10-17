import { format } from 'util';
import { OptionId, SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem, Option } from './BaseSubjectResolver.js';

class SingleSelection extends BaseSubjectResolver {
  protected type: SubjectType = 'single_selection';
  private wrongOptions: Option[] = [];

  async addAnswerFilter(_: number, ...optionIds: OptionId[]) {
    this.wrongOptions = [
      ...new Set([
        ...this.wrongOptions,
        ...optionIds.map((optId) => {
          const option = this.subject.options.find(({ id }) => id == optId);
          if (!option)
            throw new Error(format("Oops! don't have:", optId, 'Option'));
          return option;
        }),
      ]),
    ];
  }

  override getBatchRequestData(): BatchRequestItem | null {
    if (this.isPass()) return null;

    // 无选项（如匹配题展开的子题）不请求 AI，避免产生无意义请求
    if (!this.subject.options || this.subject.options.length === 0) return null;

    // 返回过滤后的选项
    const opts = this.subject.options.flatMap((opt) =>
      new Set(this.wrongOptions.map(({ id }) => id)).has(opt.id) ? [] : opt,
    );

    // 如果有父题目描述（如 cloze 的主题目），合并到描述中
    const fullDescription = this.subject.parentDescription
      ? `${this.subject.parentDescription}\n\n问题: ${this.subject.description}`
      : this.subject.description;

    return {
      id: this.subject.id,
      type: this.type,
      description: fullDescription,
      options: opts.map((o) => o.content),
    };
  }

  async getAnswer(): Promise<OptionId[]> {
    const { options, description, parentDescription } = this.subject;

    // 平台的部分题型（如 matching 匹配题展开后的子题）会返回 type=single_selection
    // 但 options 为空数组。此时没有可选项，返回空答案而不是崩溃
    // （原实现 opts[0].id 会抛 TypeError，导致整场考试中断/400）。
    if (!options || options.length === 0) {
      return [];
    }

    if (this.wrongOptions.length == options.length) {
      throw new Error('impossable: all options is wrong!!');
    }

    // only leave one option
    if (this.isPass()) {
      const opt = options.find(
        ({ id }) => !new Set(this.wrongOptions.map(({ id }) => id)).has(id),
      );
      if (!opt) throw new Error("impossable: can't find option???");
      return [opt.id];
    }

    const opts = options.flatMap((opt) =>
      new Set(this.wrongOptions.map(({ id }) => id)).has(opt.id) ? [] : opt,
    );

    // 优先使用预获取的结果
    if (this._prefetchedResult?.indices?.length) {
      const idx = this._prefetchedResult.indices[0];
      this.clearPrefetchedResult();
      if (idx >= 0 && idx < opts.length) {
        return [opts[idx].id];
      }
    }

    // 如果有父题目描述，合并到描述中
    const fullDescription = parentDescription
      ? `${parentDescription}\n\n问题: ${description}`
      : description;

    const answer = await this.aiModel.getResponse(
      this.type,
      fullDescription,
      opts.map(({ content }) => content),
    ).catch((e) => {
      console.warn(
        `单选/判断题 AI 获取失败，使用兜底选项(第一个)：subject=${this.subject.id} type=${this.type} err=${String(e)}`,
      );
      return 0;
    });

    const idx = Number.isInteger(answer) && answer >= 0 && answer < opts.length ? answer : 0;
    return [opts[idx].id];
  }

  isPass(): boolean {
    return this.subject.options.length - this.wrongOptions.length == 1;
  }

  /**
   * 重置状态（当分数不达预期时调用，丢弃历史收集的错误答案）
   */
  reset(): void {
    this.wrongOptions = [];
    this.clearPrefetchedResult();
  }
}

export default SingleSelection;
