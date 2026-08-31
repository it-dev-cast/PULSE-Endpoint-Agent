import zipfile
import xml.etree.ElementTree as ET
import sys

# Extract text from DOCX
docx_file = r"c:\Users\Dell\Documents\casterly\Endpoint Agent\Casterly_Endpoint_Agent_PRD_v5.docx"
try:
    with zipfile.ZipFile(docx_file, 'r') as zip_ref:
        xml_content = zip_ref.read('word/document.xml')

    # Parse XML and extract text
    root = ET.fromstring(xml_content)
    namespace = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    paragraphs = root.findall('.//w:p', namespace)

    for para in paragraphs:
        text_elements = para.findall('.//w:t', namespace)
        text = ''.join([elem.text for elem in text_elements if elem.text])
        if text.strip():
            print(text)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
