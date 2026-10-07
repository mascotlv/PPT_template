
export function makePdf(count) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
    const kids = [];
    for (let i = 0; i < count; i++) {
        const pageId = objects.length + 1, streamId = pageId + 1; kids.push(pageId + ' 0 R');
        objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << >> /Contents ' + streamId + ' 0 R >>');
        const content = '1 0 0 rg 0 0 720 405 re f\n0 0 1 rg 100 100 100 100 re f\n';
        objects.push('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream');
    }
    objects[1] = '<< /Type /Pages /Count ' + count + ' /Kids [' + kids.join(' ') + '] >>';
    let output = '%PDF-1.7\n'; const offsets = [0];
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
    const xref = Buffer.byteLength(output);
    output += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    output += 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(output);
}
