import * as React from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('javascript', javascript);

export default class Highlight extends React.PureComponent<{
  className: string;
  children?: React.ReactNode;
}, {}> {
  private codeRef = React.createRef<HTMLElement>();

  componentDidMount() {
    this.highlightCode();
  }

  componentDidUpdate() {
    this.highlightCode();
  }

  highlightCode() {
    if (this.codeRef.current) {
      hljs.highlightElement(this.codeRef.current);
    }
  }

  render() {
    const { children, className } = this.props;
    return (
      <pre>
        <code ref={this.codeRef} className={className}>
          {children}
        </code>
      </pre>
    );
  }
}
